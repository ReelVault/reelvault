import { beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { parseFields } from "@/integrations/drizzle-orm/query/parsing/fields.parser";
import { librariesRepository } from "@/repositories/libraries.repository";
import { useTestDatabase } from "../helpers/test-database.helper";

const testDatabase = useTestDatabase();
const db = () => testDatabase.client();

beforeEach(async () => {
	// The fixture files point at movies that are not seeded; only the id join matters for the stats.
	await db().run(sql.raw("PRAGMA foreign_keys = OFF"));
	// The stats cache is process-wide, so an entry from an earlier test must not answer for this one.
	librariesRepository.clearStatsCache();
});

function mediaFileRow(id: string, libraryId: string, size: number) {
	// A file belongs to exactly one movie or episode (CHECK constraint), so each fixture file gets its own movie id.
	return { id, libraryId, movieId: `movie-${id}`, metadataId: "meta-1", fileName: `${id}.mkv`, filePath: `/${id}.mkv`, size };
}

describe("library stats caching", () => {
	test("aggregates media files once and serves the repeat read from the cache", async () => {
		const fields = parseFields({ fields: "id,totalMediaFiles,totalSize" });
		await db().insert(schema.libraries).values({ id: "lib-cache", name: "Cache", type: "movies", metadataStorageMode: "database" });
		await db()
			.insert(schema.mediaFiles)
			.values([mediaFileRow("mf-1", "lib-cache", 100), mediaFileRow("mf-2", "lib-cache", 250)]);

		const first = await librariesRepository.findById({ primaryId: "lib-cache", fields });
		expect(first).toMatchObject({ totalMediaFiles: 2, totalSize: 350 });

		// The cached entry outlives this write, so the repeat read must not see it.
		await db()
			.insert(schema.mediaFiles)
			.values(mediaFileRow("mf-3", "lib-cache", 999));
		const second = await librariesRepository.findById({ primaryId: "lib-cache", fields });
		expect(second).toMatchObject({ totalMediaFiles: 2, totalSize: 350 });
	});

	test("caches a zero entry for a library without media files", async () => {
		const fields = parseFields({ fields: "id,totalMediaFiles,totalSize" });
		await db().insert(schema.libraries).values({ id: "lib-empty", name: "Empty", type: "movies", metadataStorageMode: "database" });

		const result = await librariesRepository.findById({ primaryId: "lib-empty", fields });
		expect(result).toMatchObject({ totalMediaFiles: 0, totalSize: 0 });
	});

	test("attributes per-path stats to the longest matching prefix (nested paths and win32 separators)", async () => {
		const fields = parseFields({ fields: "id,paths.id,paths.path,paths.fileCount,paths.totalSize" });
		await db().insert(schema.libraries).values({ id: "lib-multi", name: "Multi", type: "movies", metadataStorageMode: "database" });
		await db()
			.insert(schema.libraryPaths)
			.values([
				{ id: "lp-root", libraryId: "lib-multi", stableKey: "sk-1", path: "/media/a", isActive: true },
				{ id: "lp-nested", libraryId: "lib-multi", stableKey: "sk-2", path: "/media/a/sub", isActive: true },
				{ id: "lp-win", libraryId: "lib-multi", stableKey: "sk-3", path: "C:\\media\\win", isActive: true },
			]);
		await db()
			.insert(schema.mediaFiles)
			.values([
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
