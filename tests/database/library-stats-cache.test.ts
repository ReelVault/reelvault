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
});
