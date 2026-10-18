import { extractYear } from "@/utils/media-match/normalize.utils";
import type { SidecarSnapshotDocument } from "./sidecar.types";

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
		year: releaseDate ? extractYear(releaseDate.slice(0, 4)) : undefined,
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
