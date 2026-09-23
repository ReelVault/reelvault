import type { SidecarArtwork, SidecarArtworkReference } from "../sidecar.types";

type IgnoredAssetReason = "unsupported-artwork-type" | "external-nfo-reference" | "unknown-sidecar";

export interface IgnoredLocalAsset {
	readonly path: string;
	readonly fileName: string;
	readonly reason: IgnoredAssetReason;
}

export interface LocalEpisodeFile {
	readonly videoPath: string;
	readonly episodeNumber?: number | undefined;
	readonly documentPath?: string | undefined;
	readonly thumbnail?: SidecarArtworkReference | undefined;
}

export interface LocalSeasonGroup {
	readonly seasonNumber: number;
	readonly seasonDocument?: string | undefined;
	readonly poster?: SidecarArtworkReference | undefined;
	readonly episodes: readonly LocalEpisodeFile[];
}

export interface LocalSeriesGroup {
	readonly seriesDirectory: string;
	readonly seriesDocument?: string | undefined;
	readonly seasonGroups: readonly LocalSeasonGroup[];
	readonly artwork: Pick<SidecarArtwork, "poster" | "backdrop">;
}

export interface LocalMovieFolder {
	readonly movieDirectory: string;
	readonly videoPaths: readonly string[];
	readonly documentPath?: string | undefined;
	readonly artwork: Pick<SidecarArtwork, "poster" | "backdrop">;
	readonly ignoredAssets: readonly IgnoredLocalAsset[];
}
