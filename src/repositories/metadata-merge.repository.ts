import { and, eq, inArray } from "drizzle-orm";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import type { DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import { forEachChunked } from "@/integrations/drizzle-orm/query/table-access/chunking.utils";
import { episodesRepository } from "@/repositories/episodes.repository";
import { refreshLatestMediaCreatedAt } from "@/repositories/metadata/media-presence.writer";
import { metadataRepository } from "@/repositories/metadata.repository";
import { moviesRepository } from "@/repositories/movies.repository";
import { seasonsRepository } from "@/repositories/seasons.repository";
import { groupBy, toMap } from "@/utils/array.utils";
import { DomainError } from "@/utils/domain.errors";

interface TvShowMergePlan {
	deleteSeasonIds: string[];
	transferSeasonIds: string[];
	deleteEpisodeIds: string[];
	mediaFileRepoints: Map<string, string[]>;
	movesByTargetSeason: Map<string, string[]>;
}

interface MergeEpisode {
	id: string;
	episodeType: string | null;
	episodeNumber: number;
}

/** Episodes are unique per (season, type, number) — a special E1 and a regular E1 both exist. */
function episodeIdentity(episode: { episodeType: string | null; episodeNumber: number }): string {
	return `${episode.episodeType ?? ""}:${episode.episodeNumber}`;
}

/** Pure merge planning — no I/O. */
export function planTvShowMerge(
	sourceSeasons: Array<{ id: string; seasonNumber: number }>,
	targetSeasons: Array<{ id: string; seasonNumber: number }>,
	srcEpsBySeason: Map<string, MergeEpisode[]>,
	tgtEpsBySeason: Map<string, MergeEpisode[]>,
): TvShowMergePlan {
	const plan: TvShowMergePlan = {
		deleteSeasonIds: [],
		transferSeasonIds: [],
		deleteEpisodeIds: [],
		mediaFileRepoints: new Map(),
		movesByTargetSeason: new Map(),
	};

	const tgtSeasonsByNumber = toMap(targetSeasons, (s) => s.seasonNumber);
	const tgtEpisodesByNumber = new Map<string, Map<string, MergeEpisode>>();
	for (const [seasonId, episodes] of tgtEpsBySeason) {
		tgtEpisodesByNumber.set(
			seasonId,
			toMap(episodes, (e) => episodeIdentity(e)),
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
			const matchEp = targetEps?.get(episodeIdentity(srcEp));
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
		await databaseFactory.transaction(
			async (tx) => {
				if (type === "movie") await this.mergeMovieMediaFiles(targetId, sourceId, tx);
				else await this.mergeTvShowData(targetId, sourceId, tx);

				// The moved files now belong to the target; the source is deleted below.
				await refreshLatestMediaCreatedAt([targetId], tx);
				await this.mergeJunctionTable(schema.watchlist, targetId, sourceId, tx);
				await this.mergeJunctionTable(schema.userRatings, targetId, sourceId, tx);
				await this.mergeCollectionMemberships(targetId, sourceId, tx);
				await metadataRepository.delete({ primaryId: sourceId, tx });
			},
			{ immediate: true },
		);
	}

	private async selectEpisodesOfSeasons(seasonIds: string[], tx: DatabaseTransaction): Promise<Array<typeof schema.episodes.$inferSelect>> {
		if (seasonIds.length === 0) return [];

		return await episodesRepository.selectMany({ where: inArray(schema.episodes.seasonId, seasonIds), tx });
	}

	private async mergeMovieMediaFiles(targetId: string, sourceId: string, tx: DatabaseTransaction) {
		const client = databaseFactory.getClient({ tx });
		const targetMovie = await moviesRepository.selectFirst({ where: eq(schema.movies.metadataId, targetId), tx });
		const sourceMovie = await moviesRepository.selectFirst({ where: eq(schema.movies.metadataId, sourceId), tx });
		// Movie rows are created lazily on first media ingest; when the target has
		// none yet, create it before repointing — setting movieId to null would
		// violate the media_files single-target check (and orphan the row).
		const targetMovieId = targetMovie?.id ?? (await moviesRepository.findOrCreateByMetadataId({ metadataId: targetId, tx }))?.id;
		if (!targetMovieId)
			throw new DomainError("internal", `Could not resolve the movie row for metadata ${targetId}`, {
				code: "metadata.merge_movie_missing",
			});

		await client
			.update(schema.mediaFiles)
			.set({ metadataId: targetId, movieId: targetMovieId })
			.where(eq(schema.mediaFiles.metadataId, sourceId));
		if (sourceMovie) await moviesRepository.delete({ primaryId: sourceMovie.id, tx });
	}

	private async mergeTvShowData(targetId: string, sourceId: string, tx: DatabaseTransaction) {
		const client = databaseFactory.getClient({ tx });
		const sourceSeasons = await seasonsRepository.selectMany({ where: eq(schema.seasons.metadataId, sourceId), tx });
		const targetSeasons = await seasonsRepository.selectMany({ where: eq(schema.seasons.metadataId, targetId), tx });

		const srcSeasonIds = sourceSeasons.map((s) => s.id);
		const tgtSeasonIds = targetSeasons.map((s) => s.id);
		const allSourceEpisodes = await this.selectEpisodesOfSeasons(srcSeasonIds, tx);
		const allTargetEpisodes = await this.selectEpisodesOfSeasons(tgtSeasonIds, tx);

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

	/**
	 * Moves the source's collection memberships to the target, keeping their place. A collection that already holds the target
	 * keeps the target's entry; the source's entry there goes with the source row.
	 */
	private async mergeCollectionMemberships(targetId: string, sourceId: string, tx: DatabaseTransaction) {
		const client = databaseFactory.getClient({ tx });
		const targetRows = await client
			.select({ collectionId: schema.metadataCollections.collectionId })
			.from(schema.metadataCollections)
			.where(eq(schema.metadataCollections.metadataId, targetId));
		const sourceRows = await client
			.select({ collectionId: schema.metadataCollections.collectionId })
			.from(schema.metadataCollections)
			.where(eq(schema.metadataCollections.metadataId, sourceId));
		const existing = new Set(targetRows.map((row) => row.collectionId));
		const transferIds = sourceRows.map((row) => row.collectionId).filter((collectionId) => !existing.has(collectionId));
		if (transferIds.length === 0) return;

		await client
			.update(schema.metadataCollections)
			.set({ metadataId: targetId })
			.where(and(eq(schema.metadataCollections.metadataId, sourceId), inArray(schema.metadataCollections.collectionId, transferIds)));
	}

	private async mergeJunctionTable(
		table: typeof schema.watchlist | typeof schema.userRatings,
		targetId: string,
		sourceId: string,
		tx: DatabaseTransaction,
	) {
		const client = databaseFactory.getClient({ tx });
		const targetRows = await client.select({ profileId: table.profileId }).from(table).where(eq(table.metadataId, targetId));
		const sourceRows = await client.select({ profileId: table.profileId }).from(table).where(eq(table.metadataId, sourceId));
		const existing = new Set(targetRows.map((r) => r.profileId));
		const duplicateProfileIds: string[] = [];
		const transferProfileIds: string[] = [];
		for (const item of sourceRows) {
			const pid = item.profileId;
			if (existing.has(pid)) duplicateProfileIds.push(pid);
			else transferProfileIds.push(pid);
		}

		if (duplicateProfileIds.length > 0) {
			await client.delete(table).where(and(eq(table.metadataId, sourceId), inArray(table.profileId, duplicateProfileIds)));
		}

		if (transferProfileIds.length > 0) {
			if (table === schema.watchlist) {
				await client
					.update(schema.watchlist)
					.set({ metadataId: targetId })
					.where(and(eq(schema.watchlist.metadataId, sourceId), inArray(schema.watchlist.profileId, transferProfileIds)));
			} else {
				await client
					.update(schema.userRatings)
					.set({ metadataId: targetId })
					.where(and(eq(schema.userRatings.metadataId, sourceId), inArray(schema.userRatings.profileId, transferProfileIds)));
			}
		}
	}
}

export const metadataMergeRepository = new MetadataMergeRepository();
