import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteOfflineCatalogRebuildService } from "./offline-catalog-rebuild";

test("offline rebuild creates a new catalog without provider access", async () => {
	const directory = await mkdtemp(join(tmpdir(), "reelvault-rebuild-"));
	const movieDirectory = join(directory, "Movie");
	const outputDatabasePath = join(directory, "catalog.sqlite");
	await mkdir(movieDirectory);
	await Promise.all([
		writeFile(join(movieDirectory, "movie.nfo"), "<movie><title>Offline Movie</title><tmdbid>1</tmdbid></movie>"),
		writeFile(join(movieDirectory, "Movie.mkv"), "video"),
	]);
	try {
		const report = await new SqliteOfflineCatalogRebuildService(async () => ({
			mediaKind: "movie",
			identifiers: { tmdb: "1" },
			title: "Offline Movie",
			artwork: {},
		})).rebuild({
			libraries: [{ id: crypto.randomUUID(), type: "movies", paths: [directory] }],
			outputDatabasePath,
		});
		expect(report).toMatchObject({ importedMovies: 1, importedMediaFiles: 1, skipped: [] });
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
});
