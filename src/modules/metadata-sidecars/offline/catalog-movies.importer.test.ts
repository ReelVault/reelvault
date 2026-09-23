import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanonicalSidecarDocument } from "../sidecar.types";
import { CatalogMoviesImporter } from "./catalog-movies.importer";
import { CatalogTreeWalker } from "./catalog-tree.walker";

const movieDocument: CanonicalSidecarDocument = {
	mediaKind: "movie",
	identifiers: { tmdb: "1" },
	title: "Offline Movie",
	year: 2013,
	artwork: {},
};

async function createMovieLibraryRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "reelvault-movies-import-"));
	const movieDirectory = join(root, "Movie");
	await mkdir(join(movieDirectory, "extras"), { recursive: true });
	await Promise.all([
		writeFile(join(movieDirectory, "movie.nfo"), "<movie><title>Offline Movie</title></movie>"),
		writeFile(join(movieDirectory, "film.mkv"), "video"),
		writeFile(join(movieDirectory, "extras", "bonus.mkv"), "video"),
	]);

	return root;
}

function createTestDatabase(): Database {
	const database = new Database(":memory:");
	database.run(
		"CREATE TABLE metadata (id TEXT PRIMARY KEY, stable_key TEXT NOT NULL, title TEXT NOT NULL, original_title TEXT, overview TEXT, tagline TEXT, type TEXT NOT NULL, status TEXT, release_date TEXT, popularity REAL, created_at INTEGER, updated_at INTEGER)",
	);
	database.run(
		"CREATE TABLE movies (id TEXT PRIMARY KEY, stable_key TEXT NOT NULL, metadata_id TEXT NOT NULL, created_at INTEGER, updated_at INTEGER)",
	);
	database.run(
		"CREATE TABLE media_files (id TEXT PRIMARY KEY, library_id TEXT NOT NULL, metadata_id TEXT NOT NULL, movie_id TEXT, episode_id TEXT, file_path TEXT NOT NULL, file_name TEXT NOT NULL, is_default INTEGER, created_at INTEGER, updated_at INTEGER)",
	);

	return database;
}

describe("CatalogMoviesImporter", () => {
	test("imports a movie per sidecar and claims only videos next to the document (no recursion)", async () => {
		const root = await createMovieLibraryRoot();
		const database = createTestDatabase();
		try {
			const tree = await new CatalogTreeWalker({ listEntries: listRealEntries, getIoConcurrency: () => 4 }).collect(root);
			const skipped: Array<{ path: string; reason: string }> = [];

			const result = await new CatalogMoviesImporter({ readSidecarDocument: async () => movieDocument }).import(
				database,
				"library-1",
				root,
				tree,
				skipped,
			);

			expect(result).toEqual({ entries: 1, mediaFiles: 1 });
			expect(skipped).toEqual([]);
			expect(database.query("SELECT title, type FROM metadata").all()).toEqual([{ title: "Offline Movie", type: "movie" }]);
			const mediaFiles = database.query("SELECT file_name, is_default FROM media_files").all();
			expect(mediaFiles).toEqual([{ file_name: "film.mkv", is_default: 1 }]);
			database.close();
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	test("records an issue for unsupported or title-less movie sidecars", async () => {
		const root = await createMovieLibraryRoot();
		const database = createTestDatabase();
		try {
			const tree = await new CatalogTreeWalker({ listEntries: listRealEntries, getIoConcurrency: () => 4 }).collect(root);
			const skipped: Array<{ path: string; reason: string }> = [];

			await new CatalogMoviesImporter({ readSidecarDocument: async () => null }).import(database, "library-1", root, tree, skipped);

			expect(skipped).toEqual([{ path: join(root, "Movie", "movie.nfo"), reason: "unsupported or invalid movie sidecar" }]);
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
