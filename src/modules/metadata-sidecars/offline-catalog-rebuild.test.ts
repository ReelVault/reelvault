import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTree } from "@/utils/directory.utils";
import { SqliteOfflineCatalogRebuildService } from "./offline-catalog-rebuild.service";

test("offline rebuild writes a catalog database from the sidecars and media files on disk", async () => {
	const directory = await mkdtemp(join(tmpdir(), "reelvault-rebuild-"));
	const movieDirectory = join(directory, "Movie");
	const outputDatabasePath = join(directory, "catalog.sqlite");
	await mkdir(movieDirectory);
	await Promise.all([
		writeFile(join(movieDirectory, "movie.nfo"), "<movie><title>Offline Movie</title><tmdbid>1</tmdbid></movie>"),
		writeFile(join(movieDirectory, "Movie.mkv"), "video"),
	]);
	try {
		const report = await new SqliteOfflineCatalogRebuildService().rebuild({
			libraries: [{ id: crypto.randomUUID(), type: "movies", paths: [directory] }],
			outputDatabasePath,
		});
		expect(report).toMatchObject({ importedMovies: 1, importedMediaFiles: 1, skipped: [] });

		const catalog = new Database(outputDatabasePath, { readonly: true });
		try {
			expect(catalog.query("SELECT title FROM metadata").all()).toEqual([{ title: "Offline Movie" }]);
			expect(catalog.query("SELECT file_name FROM media_files").all()).toEqual([{ file_name: "Movie.mkv" }]);
		} finally {
			catalog.close();
		}
	} finally {
		await removeTree(directory);
	}
});
