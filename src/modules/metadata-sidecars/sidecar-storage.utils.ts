import { dirname, resolve } from "node:path";
import type { MetadataStorageMode } from "@reelvault/sdk/common";
import { isSubpath } from "@/utils/path.utils";
import type { SidecarStorageLibrary } from "./sidecar.types";

export interface PreparedStorageRoots {
	readonly paths: SidecarStorageLibrary["paths"];
	readonly resolved: readonly string[];
}

/** Resolves the library roots once per batch — matching runs per media file. */
export function prepareStorageRoots(library: SidecarStorageLibrary): PreparedStorageRoots {
	return { paths: library.paths, resolved: library.paths.map((path) => resolve(path.path)) };
}

/** Index of the longest configured root that equals `target` or is one of its ancestors. */
function longestMatchingRootIndex(resolvedRoots: readonly string[], target: string): number | undefined {
	let bestIndex: number | undefined;
	let bestLength = -1;
	for (let index = 0; index < resolvedRoots.length; index++) {
		const resolved = resolvedRoots[index] ?? "";
		if ((target === resolved || isSubpath(target, resolved)) && resolved.length > bestLength) {
			bestIndex = index;
			bestLength = resolved.length;
		}
	}

	return bestIndex;
}

export function resolveMetadataStorageMode(
	library: SidecarStorageLibrary,
	filePath: string,
	roots: PreparedStorageRoots,
): MetadataStorageMode {
	const index = longestMatchingRootIndex(roots.resolved, resolve(filePath));
	if (index === undefined) return library.metadataStorageMode;

	return roots.paths[index]?.metadataStorageMode ?? library.metadataStorageMode;
}

export function usesSidecars(mode: MetadataStorageMode): boolean {
	return mode === "sidecar" || mode === "database_and_sidecar";
}

export function resolveSeriesDirectory(roots: PreparedStorageRoots, episodeDirectory: string): string {
	const index = longestMatchingRootIndex(roots.resolved, episodeDirectory);
	const bestMatch = index === undefined ? undefined : roots.resolved[index];

	return bestMatch === episodeDirectory ? episodeDirectory : dirname(episodeDirectory);
}
