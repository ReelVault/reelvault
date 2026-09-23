import type { MetadataStorageMode } from "@sdk/common/library.types";
import { PathUtils } from "@/utils/path.utils";
import type { SidecarStorageLibrary } from "./sidecar-metadata-storage.service";

/** Index of the longest configured root that equals `target` or is one of its ancestors. */
function longestMatchingRootIndex(rootPaths: readonly string[], target: string): number | undefined {
	let bestIndex: number | undefined;
	let bestLength = -1;
	for (let index = 0; index < rootPaths.length; index++) {
		const resolved = PathUtils.resolve(rootPaths[index] ?? "");
		if ((target === resolved || PathUtils.isSubpath(target, resolved)) && resolved.length > bestLength) {
			bestIndex = index;
			bestLength = resolved.length;
		}
	}

	return bestIndex;
}

export function resolveMetadataStorageMode(library: SidecarStorageLibrary, filePath: string): MetadataStorageMode {
	const index = longestMatchingRootIndex(
		library.paths.map((path) => path.path),
		PathUtils.resolve(filePath),
	);
	if (index === undefined) return library.metadataStorageMode;

	return library.paths[index]?.metadataStorageMode ?? library.metadataStorageMode;
}

export function usesSidecars(mode: MetadataStorageMode): boolean {
	return mode === "sidecar" || mode === "database_and_sidecar";
}

export function resolveSeriesDirectory(paths: SidecarStorageLibrary["paths"], episodeDirectory: string): string {
	const index = longestMatchingRootIndex(
		paths.map((path) => path.path),
		episodeDirectory,
	);
	const bestMatch = index === undefined ? undefined : PathUtils.resolve(paths[index]?.path ?? "");

	return bestMatch === episodeDirectory ? episodeDirectory : PathUtils.getDirName(episodeDirectory);
}
