import { basename } from "node:path";
import type { SidecarArtworkReference } from "@/modules/metadata-sidecars/sidecar.types";
import { getFileNameWithoutExt } from "@/utils/path.utils";
import { episodeThumbFileName, TITLE_BACKDROP_NAMES, TITLE_POSTER_NAMES, UNSUPPORTED_ARTWORK_REGEX } from "./artwork.constants";
import type { IgnoredLocalAsset } from "./local-media.utils";

const NUMBERED_BACKDROP_REGEX = /^backdrop(\d+)\.jpg$/;

export function indexByLowerCaseName(paths: readonly string[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const path of paths) {
		map.set(basename(path).toLowerCase(), path);
	}

	return map;
}

export function selectMovieArtwork(files: ReadonlyMap<string, string>): {
	poster?: SidecarArtworkReference | undefined;
	backdrop?: SidecarArtworkReference | undefined;
} {
	return {
		poster: findArtwork(files, TITLE_POSTER_NAMES),
		backdrop: findArtwork(files, TITLE_BACKDROP_NAMES, true),
	};
}

export function selectIgnoredAssets(paths: readonly string[]): IgnoredLocalAsset[] {
	return paths.flatMap((path) => toIgnoredAsset(path));
}

/** Maps one path to the ignored-asset record when its file name is an unsupported artwork type. */
export function toIgnoredAsset(path: string): IgnoredLocalAsset[] {
	const fileName = basename(path);

	return UNSUPPORTED_ARTWORK_REGEX.test(fileName) ? [{ path, fileName, reason: "unsupported-artwork-type" as const }] : [];
}

export function selectEpisodeThumbnail(videoPath: string, files: ReadonlyMap<string, string>): SidecarArtworkReference | undefined {
	const baseName = getFileNameWithoutExt(videoPath);

	return findArtwork(files, [episodeThumbFileName(baseName)]);
}

function findArtwork(
	files: ReadonlyMap<string, string>,
	names: readonly string[],
	allowNumberedBackdrops = false,
): SidecarArtworkReference | undefined {
	for (const name of names) {
		// The index is lowercased; episode basenames keep their original case.
		const path = files.get(name.toLowerCase());
		if (path) return { path };
	}

	if (!allowNumberedBackdrops) return undefined;

	return lowestNumberedBackdrop(files);
}

/** The lowest-numbered `backdropN.jpg`, so the pick does not depend on the order the directory lists files in. */
function lowestNumberedBackdrop(files: ReadonlyMap<string, string>): SidecarArtworkReference | undefined {
	let lowest: { backdropNumber: number; path: string } | undefined;
	for (const [name, path] of files) {
		const match = NUMBERED_BACKDROP_REGEX.exec(name);
		if (!match) continue;

		const backdropNumber = Number(match[1]);
		if (!lowest || backdropNumber < lowest.backdropNumber) lowest = { backdropNumber, path };
	}

	return lowest ? { path: lowest.path } : undefined;
}
