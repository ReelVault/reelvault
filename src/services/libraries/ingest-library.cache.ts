import type { LibraryWithRelations } from "@reelvault/sdk/common";
import { MemoryCache } from "@/utils/memory.cache";

/**
 * One ingest job = one file, and every job needs the same immutable-during-scan
 * library row (paths + storage mode). Without this cache a 5000-file import
 * re-queried the library (plus its stats aggregate) 5000 times. Invalidated by
 * the library service on update/delete.
 */
const ingestLibraries = new MemoryCache<LibraryWithRelations>({
	ttlMs: 30_000,
	maxSize: 16,
	name: "ingest.library",
});

/** Reads a library through the ingest cache, loading and caching it on a miss. */
export async function findIngestLibrary(
	libraryId: string,
	load: (libraryId: string) => Promise<LibraryWithRelations | undefined>,
): Promise<LibraryWithRelations | undefined> {
	const cached = ingestLibraries.get(libraryId);
	if (cached) return cached;

	const library = await load(libraryId);
	if (library) ingestLibraries.set(libraryId, library);

	return library;
}

export function invalidateIngestLibrary(libraryId: string): void {
	ingestLibraries.delete(libraryId);
}
