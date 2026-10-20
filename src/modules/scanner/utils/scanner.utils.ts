import { normalizePath, resolvePath } from "@/utils/path.utils";

export function filterPathsWithinRoots(filePaths: string[], roots: string[]): string[] {
	if (filePaths.length === 0 || roots.length === 0) return [];

	const resolvedRoots = roots.map((root) => {
		// Normalize to forward slashes: on Windows a resolved root uses `\`, which
		// would never prefix-match a resolved file path in this comparison.
		const resolved = normalizePath(resolvePath(root));

		return resolved.endsWith("/") ? resolved : `${resolved}/`;
	});

	return filePaths.filter((filePath) => {
		const resolved = normalizePath(resolvePath(filePath));

		return resolvedRoots.some((prefix) => resolved.startsWith(prefix));
	});
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
