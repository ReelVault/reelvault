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

export const ReelVaultPathPolicy = {
	movie(directory: string): string {
		return assertWithinDirectory(directory, PathUtils.join(directory, "movie.reelvault.nfo"));
	},
	series(directory: string): string {
		return assertWithinDirectory(directory, PathUtils.join(directory, "tvshow.reelvault.nfo"));
	},
	season(directory: string, seasonNumber: number): string {
		return assertWithinDirectory(directory, PathUtils.join(directory, `season${formatSeasonNumber(seasonNumber)}-reelvault.nfo`));
	},
	episode(directory: string, videoBaseName: string): string {
		return episodeDocumentPath(directory, videoBaseName, ".reelvault.nfo");
	},
};

/** Standard NFO names as written by Kodi and read back by Kodi, Plex and Jellyfin. */
export const KodiPathPolicy = {
	movie(directory: string): string {
		return assertWithinDirectory(directory, PathUtils.join(directory, "movie.nfo"));
	},
	series(directory: string): string {
		return assertWithinDirectory(directory, PathUtils.join(directory, "tvshow.nfo"));
	},
	season(directory: string, seasonNumber: number): string {
		return assertWithinDirectory(directory, PathUtils.join(directory, `season${formatSeasonNumber(seasonNumber)}.nfo`));
	},
	episode(directory: string, videoBaseName: string): string {
		return episodeDocumentPath(directory, videoBaseName, ".nfo");
	},
};

export function getSidecarPathPolicy(flavor: SidecarFlavor): typeof ReelVaultPathPolicy {
	return flavor === "kodi" ? KodiPathPolicy : ReelVaultPathPolicy;
}
