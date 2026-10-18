import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTree } from "@/utils/directory.utils";
import { CatalogMoviesImporter } from "./catalog-movies.importer";
import { CatalogSchemaBuilder } from "./catalog-schema.builder";
import { CatalogTreeWalker } from "./catalog-tree.walker";

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

async function createTestDatabase(): Promise<Database> {
	const database = new Database(":memory:");
	await new CatalogSchemaBuilder().createSchema(database);
	database.run(
		"INSERT INTO libraries (id, name, type, metadata_storage_mode, created_at, updated_at) VALUES ('library-1', 'library-1', 'movies', 'database', 0, 0)",
	);

	return database;
}

describe("CatalogMoviesImporter", () => {
	test("imports a movie per sidecar and claims only videos next to the document (no recursion)", async () => {
		const root = await createMovieLibraryRoot();
		const database = await createTestDatabase();
		try {
			const tree = await new CatalogTreeWalker({ listEntries: listRealEntries, getIoConcurrency: () => 4 }).collect(root);
			const skipped: Array<{ path: string; reason: string }> = [];

			const result = await new CatalogMoviesImporter().import(database, "library-1", root, tree, skipped);

			expect(result).toEqual({ entries: 1, mediaFiles: 1 });
			expect(skipped).toEqual([]);
			expect(database.query("SELECT title, type FROM metadata").all()).toEqual([{ title: "Offline Movie", type: "movie" }]);
			const mediaFiles = database.query("SELECT file_name, is_default FROM media_files").all();
			expect(mediaFiles).toEqual([{ file_name: "film.mkv", is_default: 1 }]);
			database.close();
		} finally {
			await removeTree(root);
		}
	});

	test("records an issue when the movie sidecar cannot be read as a movie", async () => {
		const root = await createMovieLibraryRoot();
		await writeFile(join(root, "Movie", "movie.nfo"), "not an nfo document");
		const database = await createTestDatabase();
		try {
			const tree = await new CatalogTreeWalker({ listEntries: listRealEntries, getIoConcurrency: () => 4 }).collect(root);
			const skipped: Array<{ path: string; reason: string }> = [];

			await new CatalogMoviesImporter().import(database, "library-1", root, tree, skipped);

			expect(skipped).toEqual([{ path: join(root, "Movie", "movie.nfo"), reason: "unsupported or invalid movie sidecar" }]);
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
