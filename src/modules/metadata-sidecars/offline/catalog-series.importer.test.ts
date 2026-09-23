import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanonicalSidecarDocument } from "../sidecar.types";
import { CatalogSeriesImporter } from "./catalog-series.importer";
import { CatalogTreeWalker } from "./catalog-tree.walker";

const seriesDocument: CanonicalSidecarDocument = {
	mediaKind: "series",
	identifiers: { tmdb: "1408" },
	title: "The Expanse",
	year: 2015,
	artwork: {},
};

function createTestDatabase(): Database {
	const database = new Database(":memory:");
	database.run(
		"CREATE TABLE metadata (id TEXT PRIMARY KEY, stable_key TEXT NOT NULL, title TEXT NOT NULL, original_title TEXT, overview TEXT, tagline TEXT, type TEXT NOT NULL, status TEXT, release_date TEXT, popularity REAL, created_at INTEGER, updated_at INTEGER)",
	);
	database.run(
		"CREATE TABLE seasons (id TEXT PRIMARY KEY, stable_key TEXT NOT NULL, metadata_id TEXT NOT NULL, season_number INTEGER, created_at INTEGER, updated_at INTEGER)",
	);
	database.run(
		"CREATE TABLE episodes (id TEXT PRIMARY KEY, stable_key TEXT NOT NULL, season_id TEXT NOT NULL, type TEXT NOT NULL, episode_number INTEGER, title TEXT, created_at INTEGER, updated_at INTEGER)",
	);
	database.run(
		"CREATE TABLE media_files (id TEXT PRIMARY KEY, library_id TEXT NOT NULL, metadata_id TEXT NOT NULL, movie_id TEXT, episode_id TEXT, file_path TEXT NOT NULL, file_name TEXT NOT NULL, is_default INTEGER, created_at INTEGER, updated_at INTEGER)",
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
		writeFile(join(root, "Show", "extras", "S02E01.mkv"), "video"),
		writeFile(join(root, "Show", "behind-the-scenes.mkv"), "video"),
	]);

	return root;
}

describe("CatalogSeriesImporter", () => {
	test("imports a series with seasons, episodes and media files from the whole subtree", async () => {
		const root = await createSeriesLibraryRoot();
		const database = createTestDatabase();
		try {
			const tree = await new CatalogTreeWalker({ listEntries: listRealEntries, getIoConcurrency: () => 4 }).collect(root);
			const skipped: Array<{ path: string; reason: string }> = [];

			const result = await new CatalogSeriesImporter({ readSidecarDocument: async () => seriesDocument }).import(
				database,
				"library-1",
				root,
				tree,
				skipped,
			);

			expect(result).toEqual({ entries: 1, mediaFiles: 3 });
			expect(skipped).toEqual([]);
			expect(database.query("SELECT title, type FROM metadata").all()).toEqual([{ title: "The Expanse", type: "tv_show" }]);
			const seasons = database.query("SELECT season_number FROM seasons ORDER BY season_number").all();
			expect(seasons).toEqual([{ season_number: 1 }, { season_number: 2 }]);
			const episodeTitles = database.query("SELECT title FROM episodes ORDER BY title").all();
			expect(episodeTitles).toEqual([{ title: "S01E01.mkv" }, { title: "S02E01.mkv" }, { title: "s02e01.mkv" }]);
			const defaults = database.query("SELECT COUNT(*) AS count FROM media_files WHERE is_default = 1").get();
			expect(defaults).toEqual({ count: 3 });
			database.close();
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	test("records an issue for unsupported series sidecars and imports nothing", async () => {
		const root = await createSeriesLibraryRoot();
		const database = createTestDatabase();
		try {
			const tree = await new CatalogTreeWalker({ listEntries: listRealEntries, getIoConcurrency: () => 4 }).collect(root);
			const skipped: Array<{ path: string; reason: string }> = [];

			await new CatalogSeriesImporter({ readSidecarDocument: async () => ({ ...seriesDocument, title: undefined }) }).import(
				database,
				"library-1",
				root,
				tree,
				skipped,
			);

			expect(skipped).toEqual([{ path: join(root, "Show", "tvshow.nfo"), reason: "unsupported or invalid series sidecar" }]);
			expect(database.query("SELECT COUNT(*) AS count FROM metadata").get()).toEqual({ count: 0 });
			database.close();
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});
});

async function listRealEntries(directory: string) {
	const entries = await readdir(directory, { withFileTypes: true });

	return entries.map((entry) => ({ name: entry.name, isFile: entry.isFile(), isDirectory: entry.isDirectory() }));
}
