import { librariesRepository } from "@/repositories/libraries.repository";
import { mediaRepository } from "@/repositories/media-files.repository";
import { MemoryCache } from "@/utils/memory.cache";

/**
 * Per-library metadata language overrides. A scan re-reads one library row per
 * file otherwise; the cache is short so a PATCH to the override lands quickly.
 * `""` encodes "no override" because `MemoryCache.get` uses null as a miss.
 */
const libraryLanguageCache = new MemoryCache<string>({ ttlMs: 30_000, maxSize: 64, name: "metadata.libraryLanguage" });

/** Drops the cached metadata-language override after an admin edits the library. */
export function invalidateLibraryLanguageCache(libraryId: string): void {
	libraryLanguageCache.delete(libraryId);
}

/** The library's metadata-language override, if any. */
export async function resolveLibraryLanguage(libraryId: string | undefined): Promise<string | undefined> {
	if (!libraryId) return undefined;

	const cached = libraryLanguageCache.get(libraryId);
	if (cached !== null) return cached || undefined;

	const library = await librariesRepository.findByIdForRead(libraryId).catch(() => null);
	const language = library?.metadataLanguage ?? "";
	libraryLanguageCache.set(libraryId, language);

	return language || undefined;
}

/**
 * The metadata-language override of the library holding a title's files. A title
 * can have files in several libraries; the first root file decides.
 */
export async function resolveMetadataLanguage(metadataId: string): Promise<string | undefined> {
	const [root] = await mediaRepository.findRootsByMetadataId(metadataId);

	return await resolveLibraryLanguage(root?.libraryId);
}
