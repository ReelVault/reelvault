import { afterEach, describe, expect, test } from "bun:test";
import { librariesRepository } from "@/repositories/libraries.repository";
import { insertMovieMediaFile } from "../../../../../tests/helpers/media.fixture";
import { type MethodStub, stubMethod } from "../../../../../tests/helpers/method-stub.helper";
import { insertLibraries, insertMediaFiles, selectMovies } from "../../../../../tests/helpers/rows.fixture";
import { useTestDatabase } from "../../../../../tests/helpers/test-database.helper";
import { resolveLibraryLanguage, resolveMetadataLanguage } from "./library-metadata-language.resolver";

const db = useTestDatabase();
const stubs: MethodStub[] = [];

afterEach(() => {
	for (const stub of stubs.splice(0).toReversed()) stub.restore();
});

async function insertLibrary(name: string, metadataLanguage: string): Promise<string> {
	const [library] = await insertLibraries(db.client(), { name, type: "movies", metadataLanguage });
	if (!library) throw new Error("Expected the library insert to return a row");

	return library.id;
}

describe("resolveLibraryLanguage", () => {
	test("does not cache a failed lookup, so the next read returns the stored override", async () => {
		const libraryId = await insertLibrary("Polish movies", "pl");
		const original = librariesRepository.findByIdForRead.bind(librariesRepository);
		let failNext = true;
		stubs.push(
			stubMethod(librariesRepository, "findByIdForRead", (id: string) => {
				if (failNext) {
					failNext = false;

					return Promise.reject(new Error("database is locked"));
				}

				return original(id);
			}),
		);

		expect(await resolveLibraryLanguage(libraryId)).toBeUndefined();
		expect(await resolveLibraryLanguage(libraryId)).toBe("pl");
	});
});

describe("resolveMetadataLanguage", () => {
	test("takes the override of the library holding the file with the lowest path", async () => {
		// The first file (under /z, in the "Movies" library) is inserted before the second, so insertion order alone would pick "pl".
		await insertLibrary("Movies", "pl");
		await insertMovieMediaFile(db.client(), "/z/movie.mkv", "movie-1");
		const movie = (await selectMovies(db.client())).find((row) => row.metadataId === "movie-1");
		const english = await insertLibrary("English", "en");
		await insertMediaFiles(db.client(), {
			libraryId: english,
			metadataId: "movie-1",
			movieId: movie?.id,
			filePath: "/a/movie.mkv",
			fileName: "movie.mkv",
		});

		expect(await resolveMetadataLanguage("movie-1")).toBe("en");
	});
});
