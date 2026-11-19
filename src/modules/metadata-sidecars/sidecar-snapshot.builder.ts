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

export const SIDECAR_SNAPSHOT_SCHEMA_VERSION = 1;

/** A snapshot document with empty collections; the caller fills in the fields it knows. */
export function snapshotDocument(
	fields: Pick<SidecarSnapshotDocument, "title"> & Partial<SidecarSnapshotDocument>,
): SidecarSnapshotDocument {
	return {
		reelvaultSchemaVersion: SIDECAR_SNAPSHOT_SCHEMA_VERSION,
		identifiers: {},
		genres: [],
		keywords: [],
		productionCompanies: [],
		cast: [],
		crew: [],
		ratings: [],
		...fields,
	};
}

/** Release year of an ISO release date (`2024-05-01` → 2024); `undefined` when there is no date. */
export function releaseYear(releaseDate: string | null | undefined): number | undefined {
	return releaseDate ? extractYear(releaseDate.slice(0, 4)) : undefined;
}

function createLocalSnapshot(
	title: string,
	releaseDate?: string | null,
	overview?: string | null,
	status?: string | null,
): SidecarSnapshotDocument {
	return snapshotDocument({
		title,
		releaseDate: releaseDate ?? undefined,
		year: releaseYear(releaseDate),
		overview: overview ?? undefined,
		status: status ?? undefined,
	});
}
