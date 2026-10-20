import type { SidecarFlavor } from "@/modules/metadata-sidecars/sidecar.types";
import { DomainError } from "@/utils/domain.errors";
import { isSubpath, joinPath } from "@/utils/path.utils";

const PATH_SEPARATOR_REGEX = /[/\\]/;

/** Every write target must resolve inside the directory it is derived from. */
function assertWithinDirectory(directory: string, documentPath: string): string {
	if (!isSubpath(documentPath, directory)) {
		throw new DomainError("validation", `Sidecar path escapes its media directory: ${documentPath}`, { code: "sidecar.path_invalid" });
	}

	return documentPath;
}

function episodeDocumentPath(directory: string, videoBaseName: string, suffix: string): string {
	return assertWithinDirectory(directory, joinPath(directory, `${assertEpisodeBaseName(videoBaseName)}${suffix}`));
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
			return assertWithinDirectory(directory, joinPath(directory, names.movie));
		},
		series(directory: string): string {
			return assertWithinDirectory(directory, joinPath(directory, names.series));
		},
		season(directory: string, seasonNumber: number): string {
			return assertWithinDirectory(directory, joinPath(directory, seasonFileName(seasonNumber, names.seasonSuffix)));
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
