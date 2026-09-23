import { and, eq, inArray } from "drizzle-orm";
import { databaseFactory } from "@/database/database";
import { episodesRepository } from "@/database/repositories/episodes.repository";
import { metadataRepository } from "@/database/repositories/metadata.repository";
import { moviesRepository } from "@/database/repositories/movies.repository";
import { seasonsRepository } from "@/database/repositories/seasons.repository";
import { schema } from "@/database/schema";
import { forEachChunked } from "@/database/table-access";
import type { DatabaseTransaction } from "@/database/types";
import { groupBy, toMap } from "@/utils/array.utils";

interface TvShowMergePlan {
	deleteSeasonIds: string[];
	transferSeasonIds: string[];
	deleteEpisodeIds: string[];
	mediaFileRepoints: Map<string, string[]>;
	movesByTargetSeason: Map<string, string[]>;
}

/** Pure merge planning — no I/O. */
function planTvShowMerge(
	sourceSeasons: Array<{ id: string; seasonNumber: number }>,
	targetSeasons: Array<{ id: string; seasonNumber: number }>,
	srcEpsBySeason: Map<string, Array<{ id: string; episodeNumber: number }>>,
	tgtEpsBySeason: Map<string, Array<{ id: string; episodeNumber: number }>>,
): TvShowMergePlan {
	const plan: TvShowMergePlan = {
		deleteSeasonIds: [],
		transferSeasonIds: [],
		deleteEpisodeIds: [],
		mediaFileRepoints: new Map(),
		movesByTargetSeason: new Map(),
	};

	const tgtSeasonsByNumber = toMap(targetSeasons, (s) => s.seasonNumber);
	const tgtEpisodesByNumber = new Map<string, Map<number, { id: string; episodeNumber: number }>>();
	for (const [seasonId, episodes] of tgtEpsBySeason) {
		tgtEpisodesByNumber.set(
			seasonId,
			toMap(episodes, (e) => e.episodeNumber),
		);
	}

	for (const srcSeason of sourceSeasons) {
		const match = tgtSeasonsByNumber.get(srcSeason.seasonNumber);
		if (!match) {
			plan.transferSeasonIds.push(srcSeason.id);
			continue;
		}

		plan.deleteSeasonIds.push(srcSeason.id);
		const targetEps = tgtEpisodesByNumber.get(match.id);
		for (const srcEp of srcEpsBySeason.get(srcSeason.id) ?? []) {
			const matchEp = targetEps?.get(srcEp.episodeNumber);
			if (matchEp) {
				const repoints = plan.mediaFileRepoints.get(matchEp.id);
				if (repoints) repoints.push(srcEp.id);
				else plan.mediaFileRepoints.set(matchEp.id, [srcEp.id]);

				plan.deleteEpisodeIds.push(srcEp.id);
			} else {
				const moves = plan.movesByTargetSeason.get(match.id);
				if (moves) moves.push(srcEp.id);
				else plan.movesByTargetSeason.set(match.id, [srcEp.id]);
			}
		}
	}

	return plan;
}

/**
 * Transactional merge of two metadata rows (movie or tv_show): repoints media
 * files, resolves duplicate seasons/episodes, and de-duplicates watchlist and
 * ratings before deleting the source row.
 */
class MetadataMergeRepository {
	async merge(targetId: string, sourceId: string, type: "movie" | "tv_show"): Promise<void> {
		await databaseFactory.transaction(async (tx) => {
			if (type === "movie") await this.mergeMovieMediaFiles(targetId, sourceId, tx);
			else await this.mergeTvShowData(targetId, sourceId, tx);

			await this.mergeJunctionTable(schema.watchlist, targetId, sourceId, tx);
			await this.mergeJunctionTable(schema.userRatings, targetId, sourceId, tx);
			await metadataRepository.delete({ primaryId: sourceId, tx });
		});
	}

	private async mergeMovieMediaFiles(targetId: string, sourceId: string, tx: DatabaseTransaction) {
		const client = databaseFactory.getClient({ tx });
		const [targetMovie, sourceMovie] = await Promise.all([
			moviesRepository.selectFirst({ where: eq(schema.movies.metadataId, targetId), tx }),
			moviesRepository.selectFirst({ where: eq(schema.movies.metadataId, sourceId), tx }),
		]);
		await client
			.update(schema.mediaFiles)
			.set({ metadataId: targetId, movieId: targetMovie?.id ?? null })
			.where(eq(schema.mediaFiles.metadataId, sourceId));
		if (sourceMovie) await moviesRepository.delete({ primaryId: sourceMovie.id, tx });
	}

	private async mergeTvShowData(targetId: string, sourceId: string, tx: DatabaseTransaction) {
		const client = databaseFactory.getClient({ tx });
		const [sourceSeasons, targetSeasons] = await Promise.all([
			seasonsRepository.selectMany({ where: eq(schema.seasons.metadataId, sourceId), tx }),
			seasonsRepository.selectMany({ where: eq(schema.seasons.metadataId, targetId), tx }),
		]);

		const srcSeasonIds = sourceSeasons.map((s) => s.id);
		const tgtSeasonIds = targetSeasons.map((s) => s.id);
		const [allSourceEpisodes, allTargetEpisodes] = await Promise.all([
			srcSeasonIds.length > 0
				? episodesRepository.selectMany({ where: inArray(schema.episodes.seasonId, srcSeasonIds), tx })
				: Promise.resolve([]),
			tgtSeasonIds.length > 0
				? episodesRepository.selectMany({ where: inArray(schema.episodes.seasonId, tgtSeasonIds), tx })
				: Promise.resolve([]),
		]);

		const srcEpsBySeason = groupBy(allSourceEpisodes, (ep) => ep.seasonId);
		const tgtEpsBySeason = groupBy(allTargetEpisodes, (ep) => ep.seasonId);

		const plan = planTvShowMerge(sourceSeasons, targetSeasons, srcEpsBySeason, tgtEpsBySeason);

		// Order matters: `seasons`/`episodes` FKs are ON DELETE CASCADE into
		// `media_files`, so every repoint/move must run BEFORE the destructive
		// deletes — otherwise merging two shows with overlapping seasons silently
		// drops the source media files (and their progress/history/markers).
		for (const [targetEpisodeId, sourceEpisodeIds] of plan.mediaFileRepoints) {
			await forEachChunked(sourceEpisodeIds, (idChunk) =>
				client
					.update(schema.mediaFiles)
					.set({ metadataId: targetId, episodeId: targetEpisodeId })
					.where(inArray(schema.mediaFiles.episodeId, idChunk)),
			);
		}

		for (const [targetSeasonId, episodeIds] of plan.movesByTargetSeason) {
			await forEachChunked(episodeIds, (idChunk) =>
				client.update(schema.episodes).set({ seasonId: targetSeasonId }).where(inArray(schema.episodes.id, idChunk)),
			);
		}

		await forEachChunked(plan.transferSeasonIds, (idChunk) =>
			client.update(schema.seasons).set({ metadataId: targetId }).where(inArray(schema.seasons.id, idChunk)),
		);

		// Destructive deletes last. Deleting episodes before seasons keeps the
		// cascade from doing the work implicitly.
		await forEachChunked(plan.deleteEpisodeIds, (idChunk) => client.delete(schema.episodes).where(inArray(schema.episodes.id, idChunk)));

		await forEachChunked(plan.deleteSeasonIds, (idChunk) => client.delete(schema.seasons).where(inArray(schema.seasons.id, idChunk)));

		await client.update(schema.mediaFiles).set({ metadataId: targetId }).where(eq(schema.mediaFiles.metadataId, sourceId));
	}

	private async mergeJunctionTable(
		table: typeof schema.watchlist | typeof schema.userRatings,
		targetId: string,
		sourceId: string,
		tx: DatabaseTransaction,
	) {
		const client = databaseFactory.getClient({ tx });
		const [targetRows, sourceRows] = await Promise.all([
			client.select({ profileId: table.profileId }).from(table).where(eq(table.metadataId, targetId)),
			client.select({ profileId: table.profileId }).from(table).where(eq(table.metadataId, sourceId)),
		]);
		const existing = new Set(targetRows.map((r) => r.profileId));
		const duplicateProfileIds: string[] = [];
		const transferProfileIds: string[] = [];
		for (const item of sourceRows) {
			const pid = item.profileId;
			if (existing.has(pid)) duplicateProfileIds.push(pid);
			else transferProfileIds.push(pid);
		}

		const ops: Array<Promise<unknown>> = [];
		if (duplicateProfileIds.length > 0) {
			ops.push(client.delete(table).where(and(eq(table.metadataId, sourceId), inArray(table.profileId, duplicateProfileIds))));
		}

		if (transferProfileIds.length > 0) {
			const updateQuery =
				table === schema.watchlist
					? client
							.update(schema.watchlist)
							.set({ metadataId: targetId })
							.where(and(eq(schema.watchlist.metadataId, sourceId), inArray(schema.watchlist.profileId, transferProfileIds)))
					: client
							.update(schema.userRatings)
							.set({ metadataId: targetId })
							.where(and(eq(schema.userRatings.metadataId, sourceId), inArray(schema.userRatings.profileId, transferProfileIds)));
			ops.push(updateQuery);
		}

		await Promise.all(ops);
	}
}

export const metadataMergeRepository = new MetadataMergeRepository();
