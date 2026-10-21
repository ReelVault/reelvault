import { afterEach, describe, expect, test } from "bun:test";
import { insertMovieMediaFile } from "../../../../../tests/helpers/media.fixture";
import {
	insertLibraries,
	insertMediaFiles,
	selectLibraries,
	selectMovies,
	updateLibraryLanguage,
} from "../../../../../tests/helpers/rows.fixture";
import { useTestDatabase } from "../../../../../tests/helpers/test-database.helper";
import { invalidateLibraryLanguageCache, resolveMetadataLanguage } from "./library-metadata-language.resolver";

/**
 * A title's metadata language follows the library that holds its first file, so refreshes and identify
 * requests ask the providers for the same language the scan used. An edited override takes effect once
 * the cached value is dropped.
 */

const { client } = useTestDatabase();

const touchedLibraryIds: string[] = [];
afterEach(() => {
	for (const libraryId of touchedLibraryIds.splice(0)) invalidateLibraryLanguageCache(libraryId);
});

async function libraryIdNamed(name: string): Promise<string> {
	const library = (await selectLibraries(client())).find((row) => row.name === name);
	if (!library) throw new Error(`The ${name} library is missing`);
	touchedLibraryIds.push(library.id);

	return library.id;
}

async function movieIdOf(metadataId: string): Promise<string> {
	const movie = (await selectMovies(client())).find((row) => row.metadataId === metadataId);
	if (!movie) throw new Error(`No movie row for ${metadataId}`);

	return movie.id;
}

async function setLibraryLanguage(libraryId: string, language: string): Promise<void> {
	await updateLibraryLanguage(client(), libraryId, language);
}

describe("resolveMetadataLanguage", () => {
	test("a title takes the metadata language of the library that holds its file", async () => {
		await insertMovieMediaFile(client(), "/movies/lang-a.mkv", "lang-title-a");
		await setLibraryLanguage(await libraryIdNamed("Movies"), "pl");

		expect(await resolveMetadataLanguage("lang-title-a")).toBe("pl");
	});

	test("the first file decides when a title has files in several libraries", async () => {
		// The helper's "Movies" library holds the first file. findRootsByMetadataId has no ORDER BY, so the
		// insertion order decides which root comes first.
		await insertMovieMediaFile(client(), "/movies/lang-b.mkv", "lang-title-b");
		await insertLibraries(client(), { name: "Movies archive", type: "movies", metadataLanguage: "fr" });
		await insertMediaFiles(client(), {
			libraryId: await libraryIdNamed("Movies archive"),
			metadataId: "lang-title-b",
			movieId: await movieIdOf("lang-title-b"),
			filePath: "/movies archive/lang-b.mkv",
			fileName: "lang-b.mkv",
		});
		await setLibraryLanguage(await libraryIdNamed("Movies"), "de");

		expect(await resolveMetadataLanguage("lang-title-b")).toBe("de");
	});

	test("an edited override takes effect once the cached value is dropped", async () => {
		await insertMovieMediaFile(client(), "/movies/lang-e.mkv", "lang-title-e");
		const libraryId = await libraryIdNamed("Movies");
		await setLibraryLanguage(libraryId, "pl");
		expect(await resolveMetadataLanguage("lang-title-e")).toBe("pl");

		await setLibraryLanguage(libraryId, "de");
		expect(await resolveMetadataLanguage("lang-title-e")).toBe("pl");

		invalidateLibraryLanguageCache(libraryId);
		expect(await resolveMetadataLanguage("lang-title-e")).toBe("de");
	});
});
