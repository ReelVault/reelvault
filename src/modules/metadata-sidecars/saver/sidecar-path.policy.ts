import { ValidationError } from "@/utils/errors";
import { PathUtils } from "@/utils/path.utils";
import type { SidecarFlavor } from "../sidecar.types";

const PATH_SEPARATOR_REGEX = /[/\\]/;

/** Every write target must resolve inside the directory it is derived from. */
function assertWithinDirectory(directory: string, documentPath: string): string {
	if (!PathUtils.isSubpath(documentPath, directory)) {
		throw new ValidationError(`Sidecar path escapes its media directory: ${documentPath}`);
	}

	return documentPath;
}

function episodeDocumentPath(directory: string, videoBaseName: string, suffix: string): string {
	return assertWithinDirectory(directory, PathUtils.join(directory, `${assertEpisodeBaseName(videoBaseName)}${suffix}`));
}

/** Episode-derived file names (sidecar documents and thumbnails) must stay flat. */
export function assertEpisodeBaseName(videoBaseName: string): string {
	if (!videoBaseName || PATH_SEPARATOR_REGEX.test(videoBaseName) || videoBaseName.includes("\0")) {
		throw new ValidationError(`Invalid episode base name for sidecar: ${videoBaseName}`);
	}

	return videoBaseName;
}

export function formatSeasonNumber(seasonNumber: number): string {
	return String(seasonNumber).padStart(2, "0");
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
			return assertWithinDirectory(directory, PathUtils.join(directory, names.movie));
		},
		series(directory: string): string {
			return assertWithinDirectory(directory, PathUtils.join(directory, names.series));
		},
		season(directory: string, seasonNumber: number): string {
			return assertWithinDirectory(directory, PathUtils.join(directory, `season${formatSeasonNumber(seasonNumber)}${names.seasonSuffix}`));
		},
		episode(directory: string, videoBaseName: string): string {
			return episodeDocumentPath(directory, videoBaseName, names.episodeSuffix);
		},
	};
}

export const ReelVaultPathPolicy = createSidecarPathPolicy({
	movie: "movie.reelvault.nfo",
	series: "tvshow.reelvault.nfo",
	seasonSuffix: "-reelvault.nfo",
	episodeSuffix: ".reelvault.nfo",
});

/** Standard NFO names as written by Kodi and read back by Kodi, Plex and Jellyfin. */
export const KodiPathPolicy = createSidecarPathPolicy({
	movie: "movie.nfo",
	series: "tvshow.nfo",
	seasonSuffix: ".nfo",
	episodeSuffix: ".nfo",
});

export function getSidecarPathPolicy(flavor: SidecarFlavor): typeof ReelVaultPathPolicy {
	return flavor === "kodi" ? KodiPathPolicy : ReelVaultPathPolicy;
}
