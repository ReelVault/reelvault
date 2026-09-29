import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { databaseFactory } from "@/database/database";
import { librariesRepository } from "@/database/repositories/libraries.repository";
import { schema } from "@/database/schema";
import { QueryFields } from "@/database/utils/fields";

const client = databaseFactory.getClient();

// Stub tables mirror the drizzle column NAMES (drizzle selects every declared
// column); never migrate the shared test database (AGENTS.md).
const STUB_TABLES = [
	`CREATE TABLE IF NOT EXISTS libraries (
		id TEXT PRIMARY KEY, name TEXT, type TEXT, metadata_storage_mode TEXT, sidecar_flavor TEXT NOT NULL DEFAULT 'reelvault',
		created_at INTEGER, updated_at INTEGER
	)`,
	`CREATE TABLE IF NOT EXISTS library_paths (
		id TEXT PRIMARY KEY, library_id TEXT, stable_key TEXT, path TEXT,
		is_active INTEGER, metadata_storage_mode TEXT, created_at INTEGER, updated_at INTEGER
	)`,
	`CREATE TABLE IF NOT EXISTS media_files (
		id TEXT PRIMARY KEY, library_id TEXT, metadata_id TEXT, movie_id TEXT, episode_id TEXT,
		file_path TEXT, file_name TEXT, format_name TEXT, duration INTEGER, file_size INTEGER,
		source_mtime_ms INTEGER, bit_rate INTEGER, source TEXT, edition TEXT, quality_tag TEXT,
		is_default INTEGER, is_enabled INTEGER, created_at INTEGER, updated_at INTEGER
	)`,
];

function mediaFileRow(id: string, libraryId: string, size: number) {
	return { id, libraryId, metadataId: "meta-1", fileName: `${id}.mkv`, filePath: `/${id}.mkv`, size };
}

beforeAll(async () => {
	for (const statement of STUB_TABLES) await client.run(sql.raw(statement));
});

beforeEach(async () => {
	await client.delete(schema.mediaFiles);
	await client.delete(schema.libraryPaths);
	await client.delete(schema.libraries);
	librariesRepository.clearStatsCache();
});

afterAll(async () => {
	await client.run(sql.raw("DROP TABLE IF EXISTS media_files"));
	await client.run(sql.raw("DROP TABLE IF EXISTS libraries"));
});

describe("library stats caching", () => {
	test("aggregates media files once and serves the repeat read from the cache", async () => {
		const fields = QueryFields.parse({ fields: "id,totalMediaFiles,totalSize" });
		await client.insert(schema.libraries).values({ id: "lib-cache", name: "Cache", type: "movies", metadataStorageMode: "database" });
		await client.insert(schema.mediaFiles).values([mediaFileRow("mf-1", "lib-cache", 100), mediaFileRow("mf-2", "lib-cache", 250)]);

		const first = await librariesRepository.findById({ primaryId: "lib-cache", fields });
		expect(first).toMatchObject({ totalMediaFiles: 2, totalSize: 350 });

		// The cached entry outlives this write, so the repeat read must not see it.
		await client.insert(schema.mediaFiles).values(mediaFileRow("mf-3", "lib-cache", 999));
		const second = await librariesRepository.findById({ primaryId: "lib-cache", fields });
		expect(second).toMatchObject({ totalMediaFiles: 2, totalSize: 350 });
	});

	test("caches a zero entry for a library without media files", async () => {
		const fields = QueryFields.parse({ fields: "id,totalMediaFiles,totalSize" });
		await client.insert(schema.libraries).values({ id: "lib-empty", name: "Empty", type: "movies", metadataStorageMode: "database" });

		const result = await librariesRepository.findById({ primaryId: "lib-empty", fields });
		expect(result).toMatchObject({ totalMediaFiles: 0, totalSize: 0 });
	});

	test("attributes per-path stats to the longest matching prefix (nested paths and win32 separators)", async () => {
		const fields = QueryFields.parse({ fields: "id,paths.id,paths.path,paths.fileCount,paths.totalSize" });
		await client.insert(schema.libraries).values({ id: "lib-multi", name: "Multi", type: "movies", metadataStorageMode: "database" });
		await client.insert(schema.libraryPaths).values([
			{ id: "lp-root", libraryId: "lib-multi", stableKey: "sk-1", path: "/media/a", isActive: true },
			{ id: "lp-nested", libraryId: "lib-multi", stableKey: "sk-2", path: "/media/a/sub", isActive: true },
			{ id: "lp-win", libraryId: "lib-multi", stableKey: "sk-3", path: "C:\\media\\win", isActive: true },
		]);
		await client.insert(schema.mediaFiles).values([
			{ ...mediaFileRow("mf-1", "lib-multi", 10), filePath: "/media/a/root.mkv" },
			{ ...mediaFileRow("mf-2", "lib-multi", 20), filePath: "/media/a/sub/nested.mkv" },
			{ ...mediaFileRow("mf-3", "lib-multi", 40), filePath: "/media/outside.mkv" },
			{ ...mediaFileRow("mf-4", "lib-multi", 50), filePath: "C:\\media\\win\\clip.mkv" },
		]);

		const result = await librariesRepository.findById({ primaryId: "lib-multi", fields });
		const paths = result?.paths ?? [];
		const statsByPathId = new Map(paths.map((path) => [path.id, { fileCount: path.fileCount, totalSize: path.totalSize }]));
		expect(statsByPathId.get("lp-root")).toEqual({ fileCount: 1, totalSize: 10 });
		expect(statsByPathId.get("lp-nested")).toEqual({ fileCount: 1, totalSize: 20 });
		expect(statsByPathId.get("lp-win")).toEqual({ fileCount: 1, totalSize: 50 });
	});
});
