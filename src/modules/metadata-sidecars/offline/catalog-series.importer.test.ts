import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTree } from "@/utils/directory.utils";
import { CatalogSchemaBuilder } from "./catalog-schema.builder";
import { CatalogSeriesImporter } from "./catalog-series.importer";
import { CatalogTreeWalker } from "./catalog-tree.walker";

async function createTestDatabase(): Promise<Database> {
	const database = new Database(":memory:");
	await new CatalogSchemaBuilder().createSchema(database);
	database.run(
		"INSERT INTO libraries (id, name, type, metadata_storage_mode, created_at, updated_at) VALUES ('library-1', 'library-1', 'tv_shows', 'database', 0, 0)",
	);

	return database;
}

async function createSeriesLibraryRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "reelvault-series-import-"));
	await mkdir(join(root, "Show", "extras"), { recursive: true });
	await Promise.all([
		writeFile(join(root, "Show", "tvshow.nfo"), "<tvshow><title>The Expanse</title></tvshow>"),
		writeFile(join(root, "Show", "S01E01.mkv"), "video"),
		writeFile(join(root, "Show", "s02e01.mkv"), "video"),
		writeFile(join(root, "Show", "extras", "S03E01.mkv"), "video"),
		writeFile(join(root, "Show", "behind-the-scenes.mkv"), "video"),
	]);

	return root;
}

describe("CatalogSeriesImporter", () => {
	test("imports a series with seasons, episodes and media files from the whole subtree", async () => {
		const root = await createSeriesLibraryRoot();
		const database = await createTestDatabase();
		try {
			const tree = await new CatalogTreeWalker({ listEntries: listRealEntries, getIoConcurrency: () => 4 }).collect(root);
			const skipped: Array<{ path: string; reason: string }> = [];

			const result = await new CatalogSeriesImporter().import(database, "library-1", root, tree, skipped);

			expect(result).toEqual({ entries: 1, mediaFiles: 3 });
			expect(skipped).toEqual([]);
			expect(database.query("SELECT title, type FROM metadata").all()).toEqual([{ title: "The Expanse", type: "tv_show" }]);
			const seasons = database.query("SELECT season_number FROM seasons ORDER BY season_number").all();
			expect(seasons).toEqual([{ season_number: 1 }, { season_number: 2 }, { season_number: 3 }]);
			const episodeTitles = database.query("SELECT title FROM episodes ORDER BY title").all();
			expect(episodeTitles).toEqual([{ title: "S01E01.mkv" }, { title: "S03E01.mkv" }, { title: "s02e01.mkv" }]);
			const defaults = database.query("SELECT COUNT(*) AS count FROM media_files WHERE is_default = 1").get();
			expect(defaults).toEqual({ count: 3 });
			database.close();
		} finally {
			await removeTree(root);
		}
	});

	test("skips a second file for a season and episode the series already has and records it", async () => {
		const root = await createSeriesLibraryRoot();
		await writeFile(join(root, "Show", "extras", "S02E01.mkv"), "video");
		const database = await createTestDatabase();
		try {
			const tree = await new CatalogTreeWalker({ listEntries: listRealEntries, getIoConcurrency: () => 4 }).collect(root);
			const skipped: Array<{ path: string; reason: string }> = [];

			const result = await new CatalogSeriesImporter().import(database, "library-1", root, tree, skipped);

			expect(result).toEqual({ entries: 1, mediaFiles: 3 });
			expect(skipped.map((issue) => issue.reason)).toEqual(["season and episode number already imported; file skipped"]);
			const season2Files = database.query(
				"SELECT COUNT(*) AS count FROM media_files mf JOIN episodes e ON e.id = mf.episode_id JOIN seasons s ON s.id = e.season_id WHERE s.season_number = 2",
			);
			expect(season2Files.get()).toEqual({ count: 1 });
			database.close();
		} finally {
			await removeTree(root);
		}
	});

	test("records an issue for a series sidecar without a title and imports nothing", async () => {
		const root = await createSeriesLibraryRoot();
		await writeFile(join(root, "Show", "tvshow.nfo"), "<tvshow><plot>No title</plot></tvshow>");
		const database = await createTestDatabase();
		try {
			const tree = await new CatalogTreeWalker({ listEntries: listRealEntries, getIoConcurrency: () => 4 }).collect(root);
			const skipped: Array<{ path: string; reason: string }> = [];

			await new CatalogSeriesImporter().import(database, "library-1", root, tree, skipped);

			expect(skipped).toEqual([{ path: join(root, "Show", "tvshow.nfo"), reason: "unsupported or invalid series sidecar" }]);
			expect(database.query("SELECT COUNT(*) AS count FROM metadata").get()).toEqual({ count: 0 });
			database.close();
		} finally {
			await removeTree(root);
		}
	});
});

async function listRealEntries(directory: string) {
	const entries = await readdir(directory, { withFileTypes: true });

	return entries.map((entry) => ({ name: entry.name, isFile: entry.isFile(), isDirectory: entry.isDirectory() }));
}
