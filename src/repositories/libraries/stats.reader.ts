import { sleep } from "bun";
import { and, asc, gt, inArray, sql } from "drizzle-orm";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import type { DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import { collectKeysetPages } from "@/integrations/drizzle-orm/query/keyset/keyset-pages.utils";
import { getLibraryMediaStats, hasCatalogMediaStats } from "@/repositories/media-stats.repository";
import { groupBy } from "@/utils/array.utils";
import type { EnrichedLibraryPath, LibraryPathStats, LibraryStats, LibraryStatsCaches } from "./shared.types";

/** Rows per keyset page when aggregating per-path stats on a cold cache. */
const PATH_STATS_PAGE_SIZE = 5_000;
/** Pages between event-loop yields — bounded memory without a sleep per page. */
const PATH_STATS_YIELD_EVERY = 4;
/** Same normalization the path stats historically applied in SQL: win32 separators and trailing slashes are dropped. */
const TRAILING_SLASHES_REGEX = /\/+$/;

function normalizePathPrefix(value: string): string {
	return value.replaceAll("\\", "/").replace(TRAILING_SLASHES_REGEX, "");
}

/**
 * Aggregates media-file counts/sizes per library, adding zero entries for
 * empty libraries so the aggregate is not re-run for them. Callers that go
 * through `getOrSetMany` get one shared query per uncached id set.
 */
export async function loadLibraryStats(libraryIds: readonly string[], tx?: DatabaseTransaction): Promise<Map<string, LibraryStats>> {
	const stats = new Map<string, LibraryStats>();
	if (libraryIds.length === 0) return stats;

	if (hasCatalogMediaStats(tx)) {
		const summary = await getLibraryMediaStats(libraryIds, tx);
		for (const libraryId of libraryIds) {
			const row = summary.get(libraryId);
			stats.set(libraryId, { totalMediaFiles: row?.fileCount ?? 0, totalSize: row?.totalSize ?? 0 });
		}

		return stats;
	}

	const rows = await databaseFactory
		.getClient({ tx })
		.select({
			libraryId: schema.mediaFiles.libraryId,
			totalMediaFiles: sql<number>`count(*)`,
			totalSize: sql<number>`coalesce(sum(${schema.mediaFiles.size}), 0)`,
		})
		.from(schema.mediaFiles)
		.where(inArray(schema.mediaFiles.libraryId, libraryIds))
		.groupBy(schema.mediaFiles.libraryId);

	for (const row of rows) {
		stats.set(row.libraryId, { totalMediaFiles: row.totalMediaFiles, totalSize: row.totalSize });
	}

	for (const id of libraryIds) {
		if (!stats.has(id)) stats.set(id, { totalMediaFiles: 0, totalSize: 0 });
	}

	return stats;
}

/**
 * Computes per-path file counts/sizes. Single-path libraries reuse the
 * library-level stats; multi-path libraries resolve ownership through the
 * prefix-stats cache (or the longest-prefix SQL below).
 */
export async function enrichPathsWithStats(
	caches: LibraryStatsCaches,
	libraryIds: readonly string[],
	rawPaths: Array<typeof schema.libraryPaths.$inferSelect>,
	libraryStats: Map<string, LibraryStats>,
	tx?: DatabaseTransaction,
): Promise<Map<string, EnrichedLibraryPath[]>> {
	const enrichedPaths = new Map<string, EnrichedLibraryPath[]>();
	const pathsByLibrary = groupBy(rawPaths, (path) => path.libraryId);
	const multiPathLibraryIds = libraryIds.filter((id) => (pathsByLibrary.get(id)?.length ?? 0) > 1);
	let pathStatsByPathId: Map<string, LibraryPathStats>;
	if (multiPathLibraryIds.length > 0) {
		pathStatsByPathId = await loadPathStats(caches, pathsByLibrary, multiPathLibraryIds, tx);
	} else {
		pathStatsByPathId = new Map<string, LibraryPathStats>();
	}

	for (const libraryId of libraryIds) {
		const libPaths = pathsByLibrary.get(libraryId) ?? [];

		if (libPaths.length === 0) {
			enrichedPaths.set(libraryId, []);
			continue;
		}

		if (libPaths.length === 1) {
			const stats = libraryStats.get(libraryId) ?? { totalMediaFiles: 0, totalSize: 0 };
			const singlePath = libPaths[0];
			if (singlePath) {
				enrichedPaths.set(libraryId, [
					{
						...singlePath,
						fileCount: stats.totalMediaFiles,
						totalSize: stats.totalSize,
						size: stats.totalSize,
					},
				]);
			}

			continue;
		}

		const pathsWithStats = libPaths.map((p) => {
			const stat = pathStatsByPathId.get(p.id) ?? { fileCount: 0, totalSize: 0 };

			return {
				...p,
				fileCount: stat.fileCount,
				totalSize: stat.totalSize,
				size: stat.totalSize,
			};
		});

		enrichedPaths.set(libraryId, pathsWithStats);
	}

	return enrichedPaths;
}

/** The cached path stats of the given libraries, and the libraries that still hold an uncached path. */
function scanCachedPathStats(
	caches: LibraryStatsCaches,
	pathsByLibrary: Map<string, Array<typeof schema.libraryPaths.$inferSelect>>,
	libraryIds: readonly string[],
): { stats: Map<string, LibraryPathStats>; uncachedLibraryIds: string[] } {
	const stats = new Map<string, LibraryPathStats>();
	const uncachedLibraryIds: string[] = [];

	for (const libId of libraryIds) {
		const libPaths = pathsByLibrary.get(libId) ?? [];
		let allCached = true;
		for (const p of libPaths) {
			const cached = caches.pathStatsCache.get(p.id);
			if (cached) {
				stats.set(p.id, cached);
			} else {
				allCached = false;
			}
		}

		if (!allCached) {
			uncachedLibraryIds.push(libId);
		}
	}

	return { stats, uncachedLibraryIds };
}

/** Prefix stats for multi-path libraries: served from cache, refetched for uncached libraries via longest-prefix SQL. */
async function loadPathStats(
	caches: LibraryStatsCaches,
	pathsByLibrary: Map<string, Array<typeof schema.libraryPaths.$inferSelect>>,
	multiPathLibraryIds: readonly string[],
	tx?: DatabaseTransaction,
): Promise<Map<string, LibraryPathStats>> {
	let pathStatsByPathId = new Map<string, LibraryPathStats>();
	const uncachedMultiPathLibraryIds: string[] = [];
	if (tx) {
		uncachedMultiPathLibraryIds.push(...multiPathLibraryIds);
	} else {
		const cached = scanCachedPathStats(caches, pathsByLibrary, multiPathLibraryIds);
		pathStatsByPathId = cached.stats;
		uncachedMultiPathLibraryIds.push(...cached.uncachedLibraryIds);
	}

	if (uncachedMultiPathLibraryIds.length === 0) return pathStatsByPathId;

	const client = databaseFactory.getClient({ tx });
	// Longest-prefix-wins ownership, evaluated in JS. The previous correlated
	// SQL re-matched every library path per media-file row (16k files × 99
	// paths ≈ 0.45 s of SQLite string comparisons on a real catalog); the
	// per-library path lists are tiny and static, so one flat file scan plus
	// in-memory prefix matching keeps identical semantics at ~1/50th cost.
	const uncachedIds = new Set(uncachedMultiPathLibraryIds);
	const ownersByLibrary = new Map<string, Array<{ normalized: string; pathId: string }>>();
	for (const [libraryId, libPaths] of pathsByLibrary) {
		if (!uncachedIds.has(libraryId)) continue;
		const owners = libPaths
			.map((p) => ({ normalized: normalizePathPrefix(p.path), pathId: p.id }))
			.toSorted((left, right) => right.normalized.length - left.normalized.length);
		ownersByLibrary.set(libraryId, owners);
	}

	const totals = new Map<string, { fileCount: number; totalSize: number }>();
	const accumulate = (row: { libraryId: string; filePath: string; size: number | null }): void => {
		const owners = ownersByLibrary.get(row.libraryId);
		if (!owners) return;
		const fileKey = normalizePathPrefix(row.filePath);
		const owner = owners.find((candidate) => fileKey === candidate.normalized || fileKey.startsWith(`${candidate.normalized}/`));
		if (!owner) return;
		const entry = totals.get(owner.pathId) ?? { fileCount: 0, totalSize: 0 };
		entry.fileCount += 1;
		entry.totalSize += row.size ?? 0;
		totals.set(owner.pathId, entry);
	};

	// Keyset-paginate the flat scan: a huge multi-path library is aggregated
	// page by page (bounded peak memory) and the event loop gets a turn every
	// few pages instead of one long synchronous SELECT materializing every file.
	let pagesSinceYield = 0;
	await collectKeysetPages({
		pageSize: PATH_STATS_PAGE_SIZE,
		fetchPage: (cursor) =>
			client
				.select({
					id: schema.mediaFiles.id,
					libraryId: schema.mediaFiles.libraryId,
					filePath: schema.mediaFiles.filePath,
					size: schema.mediaFiles.size,
				})
				.from(schema.mediaFiles)
				.where(
					and(inArray(schema.mediaFiles.libraryId, uncachedMultiPathLibraryIds), cursor ? gt(schema.mediaFiles.id, cursor) : undefined),
				)
				.orderBy(asc(schema.mediaFiles.id))
				.limit(PATH_STATS_PAGE_SIZE),
		onPage: (rows) => {
			for (const row of rows) accumulate(row);
		},
		betweenPages: async () => {
			pagesSinceYield += 1;
			if (pagesSinceYield < PATH_STATS_YIELD_EVERY) return;

			pagesSinceYield = 0;

			await sleep(0);
		},
	});

	for (const [pathId, entry] of totals) {
		pathStatsByPathId.set(pathId, entry);
		if (!tx) {
			caches.pathStatsCache.set(pathId, entry);
		}
	}

	return pathStatsByPathId;
}
