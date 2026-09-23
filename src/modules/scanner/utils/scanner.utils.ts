import { PathUtils } from "@/utils/path.utils";
import type { FilePathChanges } from "../scanner.types";

export function compareFilePaths(filesOnDisk: string[], filesInDatabase: string[]): FilePathChanges {
	const diskPaths = new Set(filesOnDisk);
	const databasePaths = new Set(filesInDatabase);

	return {
		newFiles: filesOnDisk.filter((path) => !databasePaths.has(path)),
		removedFiles: filesInDatabase.filter((path) => !diskPaths.has(path)),
	};
}

export function filterPathsWithinRoots(filePaths: string[], roots: string[]): string[] {
	if (filePaths.length === 0 || roots.length === 0) return [];

	const resolvedRoots = roots.map((root) => {
		const resolved = PathUtils.resolve(root);

		return resolved.endsWith("/") ? resolved : `${resolved}/`;
	});

	return filePaths.filter((filePath) => {
		const resolved = PathUtils.resolve(filePath);

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
