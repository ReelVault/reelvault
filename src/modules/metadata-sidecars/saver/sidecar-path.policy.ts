import { basename, join } from "node:path";
import type { SidecarFlavor, SidecarMediaKind } from "@/modules/metadata-sidecars/sidecar.types";
import { DomainError } from "@/utils/domain.errors";
import { isSubpath } from "@/utils/path.utils";

const PATH_SEPARATOR_REGEX = /[/\\]/;

/** Canonical sidecar file names — one vocabulary for writers, readers, locators, scanners and importers. */
export const MOVIE_NFO = "movie.nfo";
export const SERIES_NFO = "tvshow.nfo";
export const REELVAULT_MOVIE_NFO = "movie.reelvault.nfo";
export const REELVAULT_SERIES_NFO = "tvshow.reelvault.nfo";
export const REELVAULT_SEASON_SUFFIX = "-reelvault.nfo";
export const KODI_SEASON_SUFFIX = ".nfo";
export const UNPADDED_SEASON_NFO = `season${KODI_SEASON_SUFFIX}`;

/** Standard name first, then our own snapshot, for documents imported from disk. */
export const MOVIE_DOCUMENT_NAMES = [MOVIE_NFO, REELVAULT_MOVIE_NFO] as const;
export const SERIES_DOCUMENT_NAMES = [SERIES_NFO, REELVAULT_SERIES_NFO] as const;

/** Every ReelVault-owned snapshot (movie, series, season, episode) carries this suffix. */
export const REELVAULT_SNAPSHOT_SUFFIX = ".reelvault.nfo";

const SEASON_FILE_REGEX = /^season\d*(?:-reelvault)?\.nfo$/;

function isSeasonSidecarFileName(fileName: string): boolean {
	return SEASON_FILE_REGEX.test(fileName.toLowerCase());
}

/** Classify a sidecar document by its file name. Season snapshots are seasons, not episodes. */
export function getSidecarMediaKind(documentPath: string): SidecarMediaKind {
	const name = basename(documentPath).toLowerCase();
	if (name === MOVIE_NFO || name === REELVAULT_MOVIE_NFO) return "movie";
	if (name === SERIES_NFO || name === REELVAULT_SERIES_NFO) return "series";
	if (isSeasonSidecarFileName(name)) return "season";

	return "episode";
}

/** Every write target must resolve inside the directory it is derived from. */
function assertWithinDirectory(directory: string, documentPath: string): string {
	if (!isSubpath(documentPath, directory)) {
		throw new DomainError("validation", `Sidecar path escapes its media directory: ${documentPath}`, { code: "sidecar.path_invalid" });
	}

	return documentPath;
}

function episodeDocumentPath(directory: string, videoBaseName: string, suffix: string): string {
	return assertWithinDirectory(directory, join(directory, `${assertEpisodeBaseName(videoBaseName)}${suffix}`));
}

/** Episode-derived file names (sidecar documents and thumbnails) must stay flat. */
export function assertEpisodeBaseName(videoBaseName: string): string {
	if (!videoBaseName || PATH_SEPARATOR_REGEX.test(videoBaseName) || videoBaseName.includes("\0")) {
		throw new DomainError("validation", `Invalid episode base name for sidecar: ${videoBaseName}`, { code: "sidecar.path_invalid" });
	}

	return videoBaseName;
}

function formatSeasonNumber(seasonNumber: number): string {
	return String(seasonNumber).padStart(2, "0");
}

/** Season-derived file name: `season01` with the given suffix (`.nfo`, `-poster.jpg`). */
export function seasonFileName(seasonNumber: number, suffix: string): string {
	return `season${formatSeasonNumber(seasonNumber)}${suffix}`;
}

interface SidecarFileNames {
	readonly movie: string;
	readonly series: string;
	readonly seasonSuffix: string;
	readonly episodeSuffix: string;
}

function createSidecarPathPolicy(names: SidecarFileNames) {
	return {
		movie(directory: string): string {
			return assertWithinDirectory(directory, join(directory, names.movie));
		},
		series(directory: string): string {
			return assertWithinDirectory(directory, join(directory, names.series));
		},
		season(directory: string, seasonNumber: number): string {
			return assertWithinDirectory(directory, join(directory, seasonFileName(seasonNumber, names.seasonSuffix)));
		},
		episode(directory: string, videoBaseName: string): string {
			return episodeDocumentPath(directory, videoBaseName, names.episodeSuffix);
		},
	};
}

export const ReelVaultPathPolicy = createSidecarPathPolicy({
	movie: REELVAULT_MOVIE_NFO,
	series: REELVAULT_SERIES_NFO,
	seasonSuffix: REELVAULT_SEASON_SUFFIX,
	episodeSuffix: REELVAULT_SNAPSHOT_SUFFIX,
});

/** Standard NFO names as written by Kodi and read back by Kodi, Plex and Jellyfin. */
export const KodiPathPolicy = createSidecarPathPolicy({
	movie: MOVIE_NFO,
	series: SERIES_NFO,
	seasonSuffix: KODI_SEASON_SUFFIX,
	episodeSuffix: KODI_SEASON_SUFFIX,
});

export function getSidecarPathPolicy(flavor: SidecarFlavor): typeof ReelVaultPathPolicy {
	return flavor === "kodi" ? KodiPathPolicy : ReelVaultPathPolicy;
}
