import { episodesRepository } from "@/database/repositories/episodes.repository";
import { metadataRepository } from "@/database/repositories/metadata.repository";
import { seasonsRepository } from "@/database/repositories/seasons.repository";
import { QueryFields } from "@/database/utils/fields";
import { NotFoundError } from "@/utils/errors";
import type { SidecarSnapshotDocument, SidecarSnapshotResolver } from "./sidecar.types";

export type EpisodeRecord = NonNullable<Awaited<ReturnType<typeof episodesRepository.findByPrimaryId>>>;

export type SeasonRecord = NonNullable<Awaited<ReturnType<typeof seasonsRepository.findByPrimaryId>>>;

export class DatabaseSidecarSnapshotResolver implements SidecarSnapshotResolver {
	async metadata(metadataId: string): Promise<SidecarSnapshotDocument> {
		const metadata = await metadataRepository.findById({
			primaryId: metadataId,
			fields: QueryFields.parse({
				fields: "title,originalTitle,releaseDate,overview,tagline,status,providers,genres,keywords,collections,companies,cast,crew,rating",
			}),
		});
		if (!metadata) throw new NotFoundError(`Metadata ${metadataId} does not exist`);

		const providerIds = Object.fromEntries(metadata.providers.map((provider) => [provider.name, provider.externalId]));

		return {
			reelvaultSchemaVersion: 1,
			title: metadata.title,
			originalTitle: metadata.originalTitle ?? undefined,
			releaseDate: metadata.releaseDate,
			year: toYear(metadata.releaseDate),
			overview: metadata.overview ?? undefined,
			tagline: metadata.tagline ?? undefined,
			status: metadata.status ?? undefined,
			identifiers: providerIds,
			providerIds,
			genres: metadata.genres.map((genre) => genre.name),
			keywords: metadata.keywords.map((keyword) => keyword.name),
			collection: metadata.collections[0]?.name,
			productionCompanies: metadata.companies.map((company) => company.name),
			cast: metadata.cast.flatMap((member) =>
				member.data
					? [
							{
								name: member.data.name,
								character: member.character ?? undefined,
								order: member.sortOrder >= 0 ? member.sortOrder : undefined,
							},
						]
					: [],
			),
			crew: metadata.crew.flatMap((member) => (member.data ? [{ name: member.data.name, job: member.job }] : [])),
			ratings: metadata.rating.scores.map((rating) => ({ source: rating.source, value: rating.value, voteCount: rating.votes })),
		};
	}

	async season(seasonId: string): Promise<SidecarSnapshotDocument> {
		const season = await seasonsRepository.findByPrimaryId({
			primaryId: seasonId,
			fields: QueryFields.parse({ fields: "name,seasonNumber,airDate,overview,status" }),
		});
		if (!season) throw new NotFoundError(`Season ${seasonId} does not exist`);

		return seasonSnapshot(season);
	}

	async episode(episodeId: string): Promise<SidecarSnapshotDocument> {
		const episode = await episodesRepository.findByPrimaryId({
			primaryId: episodeId,
			fields: QueryFields.parse({ fields: "title,episodeNumber,airDate,overview" }),
		});
		if (!episode) throw new NotFoundError(`Episode ${episodeId} does not exist`);

		return episodeSnapshot(episode);
	}
}

export interface SeasonSnapshotInput {
	name?: string | null | undefined;
	seasonNumber: number;
	airDate?: string | null | undefined;
	overview?: string | null | undefined;
	status?: string | null | undefined;
}

export interface EpisodeSnapshotInput {
	title?: string | null | undefined;
	seasonNumber?: number | null | undefined;
	episodeNumber: number;
	airDate?: string | null | undefined;
	overview?: string | null | undefined;
}

/** Snapshot builders shared with the storage service, which often already holds
 * the loaded row — passing the snapshot spares the writer a re-fetch. */
export function seasonSnapshot(season: SeasonSnapshotInput): SidecarSnapshotDocument {
	return {
		...createLocalSnapshot(season.name ?? `Season ${season.seasonNumber}`, season.airDate, season.overview, season.status),
		seasonNumber: season.seasonNumber,
	};
}

export function episodeSnapshot(episode: EpisodeSnapshotInput): SidecarSnapshotDocument {
	return {
		...createLocalSnapshot(episode.title ?? `Episode ${episode.episodeNumber}`, episode.airDate, episode.overview),
		...(episode.seasonNumber !== undefined && episode.seasonNumber !== null ? { seasonNumber: episode.seasonNumber } : {}),
		episodeNumber: episode.episodeNumber,
	};
}

function createLocalSnapshot(
	title: string,
	releaseDate?: string | null,
	overview?: string | null,
	status?: string | null,
): SidecarSnapshotDocument {
	return {
		reelvaultSchemaVersion: 1,
		title,
		releaseDate: releaseDate ?? undefined,
		year: releaseDate ? toYear(releaseDate) : undefined,
		overview: overview ?? undefined,
		status: status ?? undefined,
		identifiers: {},
		providerIds: {},
		genres: [],
		keywords: [],
		productionCompanies: [],
		cast: [],
		crew: [],
		ratings: [],
	};
}

function toYear(date: string): number | undefined {
	const year = Number(date.slice(0, 4));

	return Number.isInteger(year) && year > 0 ? year : undefined;
}
