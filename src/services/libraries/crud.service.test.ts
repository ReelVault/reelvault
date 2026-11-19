import { describe, expect, test } from "bun:test";
import { resolveLibraryLanguage } from "@/services/catalog/metadata/providers/library-metadata-language.resolver";
import { insertLibraries } from "../../../tests/helpers/rows.fixture";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { deleteLibrary } from "./crud.service";

const db = useTestDatabase();

describe("deleteLibrary", () => {
	test("drops the deleted library's metadata-language override from the cache", async () => {
		const [library] = await insertLibraries(db.client(), { name: "Polish", type: "movies", metadataLanguage: "pl" });
		if (!library) throw new Error("Expected the library insert to return a row");
		expect(await resolveLibraryLanguage(library.id)).toBe("pl");

		await deleteLibrary(library.id);

		expect(await resolveLibraryLanguage(library.id)).toBeUndefined();
	});
});
