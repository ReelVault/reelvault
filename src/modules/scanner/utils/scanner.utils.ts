import { resolve } from "node:path";
import { normalizePath } from "@/utils/path.utils";

/** Items a scan loop handles between `sleep(0)` yields, so a large library walk cannot hold the event loop. */
export const SCAN_YIELD_INTERVAL = 5_000;

/** Normalized `root/` prefixes shared by the path filters and the per-root removal baseline. */
export function rootPathPrefixes(roots: readonly string[]): string[] {
	return roots.map((root) => {
		// Normalize to forward slashes: on Windows a resolved root uses `\`, which
		// would never prefix-match a resolved file path in this comparison.
		const resolved = normalizePath(resolve(root));

		return resolved.endsWith("/") ? resolved : `${resolved}/`;
	});
}

export function isPathWithinRoots(filePath: string, rootPrefixes: readonly string[]): boolean {
	const resolved = normalizePath(resolve(filePath));

	return rootPrefixes.some((prefix) => resolved.startsWith(prefix));
}

export function filterPathsWithinRoots(filePaths: string[], roots: string[]): string[] {
	if (filePaths.length === 0 || roots.length === 0) return [];

	const prefixes = rootPathPrefixes(roots);

	return filePaths.filter((filePath) => isPathWithinRoots(filePath, prefixes));
}

/**
 * Safety guard for the removal phase: a transient storage failure (unmounted
 * NAS, permission error) makes a scan see an empty or drastically smaller
 * library. Removing records in that state would cascade-delete watched history
 * and markers, so the removal phase must be refused.
 */
export function isMassRemoval(existingRecords: number, removalCandidates: number, filesOnDisk: number): boolean {
	if (existingRecords <= 0 || removalCandidates <= 0) return false;

	if (filesOnDisk <= 0) return true;

	return removalCandidates >= Math.max(5, Math.ceil(existingRecords * 0.5));
}
