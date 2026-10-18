import { MINUTE } from "@/config/server/server.constants";
import type { schema } from "@/integrations/drizzle-orm/database.schema";
import { defineTableAccess } from "@/integrations/drizzle-orm/query/table-access/table-access.factory";
import { MemoryCache } from "@/utils/memory.cache";

export const libraries = defineTableAccess("libraries", {
	primaryKeyColumn: "id",
});
export const libraryPaths = defineTableAccess("libraryPaths", {
	primaryKeyColumn: "id",
});

export interface LibraryStats {
	totalMediaFiles: number;
	totalSize: number;
}

export interface LibraryPathStats {
	fileCount: number;
	totalSize: number;
}

export type EnrichedLibraryPath = typeof schema.libraryPaths.$inferSelect & LibraryPathStats & { size: number };

export interface LibraryRelations {
	paths: Map<string, EnrichedLibraryPath[]>;
	mediaFiles: Map<string, Array<typeof schema.mediaFiles.$inferSelect>>;
	stats: Map<string, LibraryStats>;
}

/** Aggregates served from memory; every write to a library or its paths clears them. */
export interface LibraryStatsCaches {
	readonly libraryStatsCache: MemoryCache<LibraryStats>;
	readonly pathStatsCache: MemoryCache<LibraryPathStats>;
}

export function createLibraryStatsCaches(): LibraryStatsCaches {
	return {
		libraryStatsCache: new MemoryCache<LibraryStats>({
			ttlMs: MINUTE,
			maxSize: 100,
			name: "library-stats",
		}),
		pathStatsCache: new MemoryCache<LibraryPathStats>({
			ttlMs: MINUTE,
			maxSize: 500,
			name: "library-path-stats",
		}),
	};
}

export function clearStatsCaches(caches: LibraryStatsCaches): void {
	caches.libraryStatsCache.clear();
	caches.pathStatsCache.clear();
}
