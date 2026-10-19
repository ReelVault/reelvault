import { readdir } from "node:fs/promises";
import { MemoryCache } from "@/utils/memory.cache";

export interface DirectoryEntry {
	name: string;
	isFile: boolean;
	isDirectory: boolean;
}

/**
 * A season pack is read once per episode — the sidecar documents, the
 * subtitles — so the listing was read from disk again for every episode of the
 * same season. The entries are cached for a few seconds: a file dropped in
 * mid-scan is picked up by the next scan or refresh (the imports are
 * idempotent).
 */
const DIRECTORY_LISTING_TTL_MS = 5_000;
const directoryListingCache = new MemoryCache<DirectoryEntry[]>({
	ttlMs: DIRECTORY_LISTING_TTL_MS,
	maxSize: 64,
	name: "sidecar-directory-listings",
});

/**
 * The entries of a directory, or undefined when it cannot be read — the caller
 * decides whether an unreadable directory is an empty one or an error.
 */
export async function listDirectoryEntries(directory: string): Promise<DirectoryEntry[] | undefined> {
	const cached = directoryListingCache.get(directory);
	if (cached) return cached;

	try {
		const entries = await readdir(directory, { withFileTypes: true });
		const result = entries.map((entry) => ({ name: entry.name, isFile: entry.isFile(), isDirectory: entry.isDirectory() }));
		directoryListingCache.set(directory, result);

		return result;
	} catch {
		return undefined;
	}
}
