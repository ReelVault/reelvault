import { PathUtils } from "@/utils/path.utils";
import type { SidecarArtworkReference } from "../sidecar.types";
import { UNSUPPORTED_ARTWORK_REGEX } from "./artwork.constants";
import type { IgnoredLocalAsset } from "./local-media-grouping";

const NUMBERED_BACKDROP_REGEX = /^backdrop\d+\.jpg$/;

export function indexByLowerCaseName(paths: readonly string[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const path of paths) {
		map.set(PathUtils.getFileName(path).toLowerCase(), path);
	}

	return map;
}

export function selectMovieArtwork(files: ReadonlyMap<string, string>): {
	poster?: SidecarArtworkReference | undefined;
	backdrop?: SidecarArtworkReference | undefined;
} {
	return {
		poster: findArtwork(files, ["folder.jpg", "poster.jpg"]),
		backdrop: findArtwork(files, ["backdrop.jpg", "landscape.jpg", "fanart.jpg"], true),
	};
}

export function selectIgnoredAssets(paths: readonly string[]): IgnoredLocalAsset[] {
	return paths.flatMap((path) => {
		const fileName = PathUtils.getFileName(path);

		return UNSUPPORTED_ARTWORK_REGEX.test(fileName) ? [{ path, fileName, reason: "unsupported-artwork-type" as const }] : [];
	});
}

export function selectEpisodeThumbnail(videoPath: string, files: ReadonlyMap<string, string>): SidecarArtworkReference | undefined {
	const baseName = PathUtils.getFileNameWithoutExt(videoPath);

	return findArtwork(files, [`${baseName}-thumb.jpg`]);
}

function findArtwork(
	files: ReadonlyMap<string, string>,
	names: readonly string[],
	allowNumberedBackdrops = false,
): SidecarArtworkReference | undefined {
	for (const name of names) {
		const path = files.get(name);
		if (path) return { path };
	}

	if (!allowNumberedBackdrops) return undefined;

	for (const [name, path] of files) {
		if (NUMBERED_BACKDROP_REGEX.test(name)) return { path };
	}

	return undefined;
}
