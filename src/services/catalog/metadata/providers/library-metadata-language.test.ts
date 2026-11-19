import { afterEach, describe, expect, test } from "bun:test";
import { insertMovieMediaFile } from "../../../../../tests/helpers/media.fixture";
import { selectLibraries, updateLibraryLanguage } from "../../../../../tests/helpers/rows.fixture";
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

async function setLibraryLanguage(libraryId: string, language: string): Promise<void> {
	await updateLibraryLanguage(client(), libraryId, language);
}

describe("resolveMetadataLanguage", () => {
	test("a title takes the metadata language of the library that holds its file", async () => {
		await insertMovieMediaFile(client(), "/movies/lang-a.mkv", "lang-title-a");
		await setLibraryLanguage(await libraryIdNamed("Movies"), "pl");

		expect(await resolveMetadataLanguage("lang-title-a")).toBe("pl");
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
