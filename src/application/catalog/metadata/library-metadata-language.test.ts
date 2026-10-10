import { afterEach, describe, expect, test } from "bun:test";
import { librariesRepository } from "@/database/repositories/libraries.repository";
import { mediaRepository } from "@/database/repositories/media-files.repository";
import { stubMethod } from "../../../../tests/helpers/method-stub";
import { invalidateLibraryLanguageCache, resolveMetadataLanguage } from "./library-metadata-language";

/**
 * A title's metadata language follows the library that holds its first file, so refreshes and identify
 * requests ask the providers for the same language the scan used. An edited override takes effect once
 * the cached value is dropped.
 */

const stubs: Array<{ restore(): void }> = [];
afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
});

function stubTitleLibraries(libraryIds: string[]): void {
	stubs.push(stubMethod(mediaRepository, "findRootsByMetadataId", () => Promise.resolve(libraryIds.map((libraryId) => ({ libraryId })))));
}

function stubLibraryLanguages(languages: Record<string, string | null>): void {
	stubs.push(
		stubMethod(librariesRepository, "findByIdForRead", (libraryId: string) =>
			Promise.resolve({ id: libraryId, metadataLanguage: languages[libraryId] ?? null }),
		),
	);
}

describe("resolveMetadataLanguage", () => {
	test("a title takes the metadata language of the library that holds its file", async () => {
		stubTitleLibraries(["lang-library-a"]);
		stubLibraryLanguages({ "lang-library-a": "pl" });

		expect(await resolveMetadataLanguage("lang-title-a")).toBe("pl");
	});

	test("the first file decides when a title has files in several libraries", async () => {
		stubTitleLibraries(["lang-library-b", "lang-library-c"]);
		stubLibraryLanguages({ "lang-library-b": "de", "lang-library-c": "fr" });

		expect(await resolveMetadataLanguage("lang-title-b")).toBe("de");
	});

	test("a library without an override yields no language", async () => {
		stubTitleLibraries(["lang-library-d"]);
		stubLibraryLanguages({ "lang-library-d": null });

		expect(await resolveMetadataLanguage("lang-title-d")).toBeUndefined();
	});

	test("an edited override takes effect once the cached value is dropped", async () => {
		let language: string | null = "pl";
		stubTitleLibraries(["lang-library-e"]);
		stubs.push(
			stubMethod(librariesRepository, "findByIdForRead", () => Promise.resolve({ id: "lang-library-e", metadataLanguage: language })),
		);

		expect(await resolveMetadataLanguage("lang-title-e")).toBe("pl");

		language = "de";
		expect(await resolveMetadataLanguage("lang-title-e")).toBe("pl");

		invalidateLibraryLanguageCache("lang-library-e");
		expect(await resolveMetadataLanguage("lang-title-e")).toBe("de");
	});
});
