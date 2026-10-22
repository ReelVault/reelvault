import { inArray, sql } from "drizzle-orm";
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
export function hasCatalogMediaStats(tx?: DatabaseTransaction): boolean {
	const client = databaseFactory.getClient({ tx });
	const rows = client.all<{ one: number }>(sql`SELECT 1 AS one FROM catalog_media_stats WHERE id = 1 LIMIT 1`);

	return rows.length > 0;
}

export function getCatalogMediaStats(tx?: DatabaseTransaction): CatalogMediaStats | undefined {
	const client = databaseFactory.getClient({ tx });
	const rows = client.all<CatalogMediaStats>(sql`
		SELECT file_count AS fileCount, total_size AS totalSize, movie_count AS movieCount,
			episode_count AS episodeCount, quality_count AS qualityCount
		FROM catalog_media_stats WHERE id = 1 LIMIT 1
	`);

	return rows[0];
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
	if (rows.length === 0 || !hasCatalogMediaStats(tx)) return;

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
	if (sizeDelta === 0 || !hasCatalogMediaStats(tx)) return;
	const delta = { ...emptyDelta(libraryId), totalSize: sizeDelta };
	await applyLibraryDelta(delta, tx);
	await applyCatalogDelta(delta, tx);
}

/** Updates only the quality-tag counter after an edit or a technical refresh. */
export async function applyMediaFileQualityDelta(libraryId: string, qualityDelta: number, tx?: DatabaseTransaction): Promise<void> {
	if (qualityDelta === 0 || !hasCatalogMediaStats(tx)) return;
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
	if ((movieDelta === 0 && episodeDelta === 0) || !hasCatalogMediaStats(tx)) return;
	const delta = { ...emptyDelta(libraryId), movieCount: movieDelta, episodeCount: episodeDelta };
	await applyLibraryDelta(delta, tx);
	await applyCatalogDelta(delta, tx);
}

/** Seeds the summary once, and serves as the repair path after a drift report. */
export async function rebuildMediaStats(tx?: DatabaseTransaction): Promise<void> {
	await runInTransaction(tx, async (runTx) => {
		const client = databaseFactory.getClient({ tx: runTx });
		await Promise.resolve(client.run(sql`DELETE FROM library_media_stats`));
		await Promise.resolve(
			client.run(sql`
				INSERT INTO library_media_stats (library_id, file_count, total_size, movie_count, episode_count, quality_count)
				SELECT library_id, COUNT(*), COALESCE(SUM(file_size), 0),
					COUNT(CASE WHEN movie_id IS NOT NULL THEN 1 END),
					COUNT(CASE WHEN episode_id IS NOT NULL THEN 1 END),
					COUNT(CASE WHEN quality_tag IS NOT NULL THEN 1 END)
				FROM media_files
				GROUP BY library_id
			`),
		);
		await Promise.resolve(
			client.run(sql`
				INSERT INTO library_media_stats (library_id, file_count, total_size, movie_count, episode_count, quality_count)
				SELECT id, 0, 0, 0, 0, 0 FROM libraries
				WHERE id NOT IN (SELECT library_id FROM library_media_stats)
			`),
		);
		await rebuildCatalogFromLibraries(runTx);
	});
}

/** Recomputes the global row from the per-library rows (used after a library deletion). */
export async function rebuildCatalogFromLibraries(tx?: DatabaseTransaction): Promise<void> {
	const client = databaseFactory.getClient({ tx });
	await Promise.resolve(
		client.run(sql`
			INSERT INTO catalog_media_stats (id, file_count, total_size, movie_count, episode_count, quality_count)
			SELECT 1, COALESCE(SUM(file_count), 0), COALESCE(SUM(total_size), 0),
				COALESCE(SUM(movie_count), 0), COALESCE(SUM(episode_count), 0), COALESCE(SUM(quality_count), 0)
			FROM library_media_stats
			WHERE 1
			ON CONFLICT(id) DO UPDATE SET
				file_count = excluded.file_count,
				total_size = excluded.total_size,
				movie_count = excluded.movie_count,
				episode_count = excluded.episode_count,
				quality_count = excluded.quality_count
		`),
	);
}
