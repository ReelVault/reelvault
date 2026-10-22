import { count, eq, inArray, sql } from "drizzle-orm";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import type { DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import { runInTransaction } from "@/integrations/drizzle-orm/query/transaction.utils";

export interface MediaFileStatsRow {
	libraryId: string;
	size: number | null;
	movieId: string | null;
	episodeId: string | null;
	qualityTag: string | null;
}

interface MediaStatsDelta {
	libraryId: string;
	fileCount: number;
	totalSize: number;
	movieCount: number;
	episodeCount: number;
	qualityCount: number;
}

export interface CatalogMediaStats {
	fileCount: number;
	totalSize: number;
	movieCount: number;
	episodeCount: number;
	qualityCount: number;
}

function emptyDelta(libraryId: string): MediaStatsDelta {
	return { libraryId, fileCount: 0, totalSize: 0, movieCount: 0, episodeCount: 0, qualityCount: 0 };
}

function sumOfLibraryStat(column: typeof schema.libraryMediaStats.fileCount) {
	return sql<number>`(SELECT COALESCE(SUM(${column}), 0) FROM ${schema.libraryMediaStats})`;
}

function rowDelta(row: MediaFileStatsRow, sign: 1 | -1): MediaStatsDelta {
	return {
		libraryId: row.libraryId,
		fileCount: sign,
		totalSize: sign * (row.size ?? 0),
		movieCount: sign * Number(Boolean(row.movieId)),
		episodeCount: sign * Number(Boolean(row.episodeId)),
		qualityCount: sign * Number(Boolean(row.qualityTag)),
	};
}

function mergeDelta(target: MediaStatsDelta, source: MediaStatsDelta): void {
	target.fileCount += source.fileCount;
	target.totalSize += source.totalSize;
	target.movieCount += source.movieCount;
	target.episodeCount += source.episodeCount;
	target.qualityCount += source.qualityCount;
}

/** True after the boot backfill created the catalog row; before that reads and writes use the live scan. */
export async function hasCatalogMediaStats(tx?: DatabaseTransaction): Promise<boolean> {
	const client = databaseFactory.getClient({ tx });
	const rows = await client
		.select({ id: schema.catalogMediaStats.id })
		.from(schema.catalogMediaStats)
		.where(eq(schema.catalogMediaStats.id, 1))
		.limit(1);

	return rows.length > 0;
}

export async function getCatalogMediaStats(tx?: DatabaseTransaction): Promise<CatalogMediaStats | undefined> {
	const client = databaseFactory.getClient({ tx });
	const [row] = await client
		.select({
			fileCount: schema.catalogMediaStats.fileCount,
			totalSize: schema.catalogMediaStats.totalSize,
			movieCount: schema.catalogMediaStats.movieCount,
			episodeCount: schema.catalogMediaStats.episodeCount,
			qualityCount: schema.catalogMediaStats.qualityCount,
		})
		.from(schema.catalogMediaStats)
		.where(eq(schema.catalogMediaStats.id, 1))
		.limit(1);

	return row;
}

export async function getLibraryMediaStats(
	libraryIds: readonly string[],
	tx?: DatabaseTransaction,
): Promise<Map<string, { fileCount: number; totalSize: number }>> {
	const result = new Map<string, { fileCount: number; totalSize: number }>();
	if (libraryIds.length === 0) return result;

	const client = databaseFactory.getClient({ tx });
	const rows = await client
		.select({
			libraryId: schema.libraryMediaStats.libraryId,
			fileCount: schema.libraryMediaStats.fileCount,
			totalSize: schema.libraryMediaStats.totalSize,
		})
		.from(schema.libraryMediaStats)
		.where(inArray(schema.libraryMediaStats.libraryId, [...libraryIds]));

	for (const row of rows) result.set(row.libraryId, { fileCount: row.fileCount, totalSize: row.totalSize });

	return result;
}

async function applyLibraryDelta(delta: MediaStatsDelta, tx?: DatabaseTransaction): Promise<void> {
	const client = databaseFactory.getClient({ tx });
	await client
		.insert(schema.libraryMediaStats)
		.values(delta)
		.onConflictDoUpdate({
			target: schema.libraryMediaStats.libraryId,
			set: {
				fileCount: sql`${schema.libraryMediaStats.fileCount} + ${delta.fileCount}`,
				totalSize: sql`${schema.libraryMediaStats.totalSize} + ${delta.totalSize}`,
				movieCount: sql`${schema.libraryMediaStats.movieCount} + ${delta.movieCount}`,
				episodeCount: sql`${schema.libraryMediaStats.episodeCount} + ${delta.episodeCount}`,
				qualityCount: sql`${schema.libraryMediaStats.qualityCount} + ${delta.qualityCount}`,
			},
		});
}

async function applyCatalogDelta(delta: MediaStatsDelta, tx?: DatabaseTransaction): Promise<void> {
	const client = databaseFactory.getClient({ tx });
	await client
		.insert(schema.catalogMediaStats)
		.values({
			id: 1,
			fileCount: delta.fileCount,
			totalSize: delta.totalSize,
			movieCount: delta.movieCount,
			episodeCount: delta.episodeCount,
			qualityCount: delta.qualityCount,
		})
		.onConflictDoUpdate({
			target: schema.catalogMediaStats.id,
			set: {
				fileCount: sql`${schema.catalogMediaStats.fileCount} + ${delta.fileCount}`,
				totalSize: sql`${schema.catalogMediaStats.totalSize} + ${delta.totalSize}`,
				movieCount: sql`${schema.catalogMediaStats.movieCount} + ${delta.movieCount}`,
				episodeCount: sql`${schema.catalogMediaStats.episodeCount} + ${delta.episodeCount}`,
				qualityCount: sql`${schema.catalogMediaStats.qualityCount} + ${delta.qualityCount}`,
			},
		});
}

/**
 * Adds (`sign = 1`) or removes (`sign = -1`) the counters for one or more media
 * files. No-op until the boot backfill created the summary, which keeps tests
 * that seed media files directly on the live fallback.
 */
export async function applyMediaFileStats(rows: readonly MediaFileStatsRow[], sign: 1 | -1, tx?: DatabaseTransaction): Promise<void> {
	if (rows.length === 0 || !(await hasCatalogMediaStats(tx))) return;

	const byLibrary = new Map<string, MediaStatsDelta>();
	const total = emptyDelta("");
	for (const row of rows) {
		const delta = rowDelta(row, sign);
		const target = byLibrary.get(delta.libraryId) ?? emptyDelta(delta.libraryId);
		mergeDelta(target, delta);
		byLibrary.set(delta.libraryId, target);
		mergeDelta(total, delta);
	}

	for (const delta of byLibrary.values()) await applyLibraryDelta(delta, tx);
	await applyCatalogDelta(total, tx);
}

/** Updates only `media_files.file_size` after a technical refresh. */
export async function applyMediaFileSizeDelta(libraryId: string, sizeDelta: number, tx?: DatabaseTransaction): Promise<void> {
	if (sizeDelta === 0 || !(await hasCatalogMediaStats(tx))) return;
	const delta = { ...emptyDelta(libraryId), totalSize: sizeDelta };
	await applyLibraryDelta(delta, tx);
	await applyCatalogDelta(delta, tx);
}

/** Updates only the quality-tag counter after an edit or a technical refresh. */
export async function applyMediaFileQualityDelta(libraryId: string, qualityDelta: number, tx?: DatabaseTransaction): Promise<void> {
	if (qualityDelta === 0 || !(await hasCatalogMediaStats(tx))) return;
	const delta = { ...emptyDelta(libraryId), qualityCount: qualityDelta };
	await applyLibraryDelta(delta, tx);
	await applyCatalogDelta(delta, tx);
}

/** Updates only the movie/episode counters after a reassign. */
export async function applyMediaFileFlagDelta(
	libraryId: string,
	movieDelta: number,
	episodeDelta: number,
	tx?: DatabaseTransaction,
): Promise<void> {
	if ((movieDelta === 0 && episodeDelta === 0) || !(await hasCatalogMediaStats(tx))) return;
	const delta = { ...emptyDelta(libraryId), movieCount: movieDelta, episodeCount: episodeDelta };
	await applyLibraryDelta(delta, tx);
	await applyCatalogDelta(delta, tx);
}

/** Seeds the summary once, and serves as the repair path after a drift report. */
export async function rebuildMediaStats(tx?: DatabaseTransaction): Promise<void> {
	await runInTransaction(tx, async (runTx) => {
		const client = databaseFactory.getClient({ tx: runTx });
		await client.delete(schema.libraryMediaStats);
		await client.insert(schema.libraryMediaStats).select(
			client
				.select({
					libraryId: schema.mediaFiles.libraryId,
					fileCount: count().as("file_count"),
					totalSize: sql<number>`coalesce(sum(${schema.mediaFiles.size}), 0)`.as("total_size"),
					movieCount: count(schema.mediaFiles.movieId).as("movie_count"),
					episodeCount: count(schema.mediaFiles.episodeId).as("episode_count"),
					qualityCount: count(schema.mediaFiles.qualityTag).as("quality_count"),
				})
				.from(schema.mediaFiles)
				.groupBy(schema.mediaFiles.libraryId),
		);
		await rebuildCatalogFromLibraries(runTx);
	});
}

/** Recomputes the global row from the per-library rows (used after a library deletion). */
export async function rebuildCatalogFromLibraries(tx?: DatabaseTransaction): Promise<void> {
	const client = databaseFactory.getClient({ tx });

	await client
		.insert(schema.catalogMediaStats)
		.values({
			id: 1,
			fileCount: sumOfLibraryStat(schema.libraryMediaStats.fileCount),
			totalSize: sumOfLibraryStat(schema.libraryMediaStats.totalSize),
			movieCount: sumOfLibraryStat(schema.libraryMediaStats.movieCount),
			episodeCount: sumOfLibraryStat(schema.libraryMediaStats.episodeCount),
			qualityCount: sumOfLibraryStat(schema.libraryMediaStats.qualityCount),
		})
		.onConflictDoUpdate({
			target: schema.catalogMediaStats.id,
			set: {
				fileCount: sql`excluded.file_count`,
				totalSize: sql`excluded.total_size`,
				movieCount: sql`excluded.movie_count`,
				episodeCount: sql`excluded.episode_count`,
				qualityCount: sql`excluded.quality_count`,
			},
		});
}
