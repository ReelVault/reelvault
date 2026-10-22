import { describe, expect, test } from "bun:test";
import { insertGenres } from "../../tests/helpers/rows.fixture";
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
