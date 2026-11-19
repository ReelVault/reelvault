import { describe, expect, test } from "bun:test";
import { insertGenres, insertMetadata } from "../../tests/helpers/rows.fixture";
import { useTestDatabase } from "../../tests/helpers/test-database.helper";
import { searchGlobal } from "./metadata-search.reader";

const db = useTestDatabase();

describe("global search over genres", () => {
	test("lists a genre that starts with the term before one that only contains it", async () => {
		await insertGenres(db.client(), [
			{ id: "g1", stableKey: "genre:docudrama", name: "Docudrama" },
			{ id: "g2", stableKey: "genre:drama", name: "Drama" },
		]);

		const result = await searchGlobal({ term: "drama", limit: 10 });

		expect(result.genres.map((genre) => genre.name)).toEqual(["Drama", "Docudrama"]);
	});

	test.each(["%", "_"])("matches %p as a literal character, not as a wildcard", async (term) => {
		await insertGenres(db.client(), [
			{ id: "g1", stableKey: "genre:drama", name: "Drama" },
			{ id: "g2", stableKey: "genre:comedy", name: "Comedy" },
		]);

		const result = await searchGlobal({ term, limit: 10 });

		expect(result.genres).toEqual([]);
	});
});

describe("global search over titles", () => {
	test("returns no more titles than the limit when typo matches fill the gap after exact matches", async () => {
		await insertMetadata(db.client(), [
			{ stableKey: "movie:matrix", title: "Matrix", type: "movie", popularity: 5, releaseDate: "2001-01-01" },
			{ stableKey: "movie:matriz", title: "Matriz", type: "movie", popularity: 4, releaseDate: "2001-01-01" },
			{ stableKey: "movie:matrax", title: "Matrax", type: "movie", popularity: 3, releaseDate: "2001-01-01" },
			{ stableKey: "movie:matrice", title: "Matrice", type: "movie", popularity: 2, releaseDate: "2001-01-01" },
		]);

		const result = await searchGlobal({ term: "matrix", limit: 3 });

		expect(result.titles.map((title) => title.title)).toEqual(["Matrix", "Matriz", "Matrax"]);
	});
});
