import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getCachedResponseBody, invalidateResponseBodies, responseCacheKey, setCachedResponseBody } from "@/utils/response-body.cache";
import { insertGenres, selectGenres } from "../../../tests/helpers/rows.fixture";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { genresService } from "./genres.service";

/**
 * Genre, company and keyword edits change what the cached catalog lists embed, so every write has to
 * drop the cached list responses. The shared CRUD base does that for all of them; genres exercise it.
 */

const { client } = useTestDatabase();

const listKey = responseCacheKey({ pathWithQuery: "/v1/genres?limit=20", cookie: "", profileId: "", auth: "", apiKey: "" });

function seedCachedList(): void {
	setCachedResponseBody(listKey, { etag: "e", body: "[]", expiresAt: Date.now() + 60_000, encoded: new Map() });
}

beforeEach(async () => {
	await insertGenres(client(), { id: "g1", stableKey: "genre:drama", name: "Drama" });
});

afterEach(() => {
	invalidateResponseBodies();
});

describe("dictionary writes flush cached catalog lists", () => {
	test("creating a genre stores it and drops the cached catalog lists", async () => {
		seedCachedList();

		await genresService.create({ name: "Comedy" });

		expect((await selectGenres(client())).map((row) => row.name)).toContain("Comedy");
		expect(getCachedResponseBody(listKey)).toBeUndefined();
	});

	test("renaming a genre stores the new name and drops the cached catalog lists", async () => {
		seedCachedList();

		await genresService.update("g1", { name: "Drama (renamed)" });

		expect((await selectGenres(client())).map((row) => row.name)).toEqual(["Drama (renamed)"]);
		expect(getCachedResponseBody(listKey)).toBeUndefined();
	});

	test("deleting a genre removes it and drops the cached catalog lists", async () => {
		seedCachedList();

		await genresService.delete("g1");

		expect(await selectGenres(client())).toEqual([]);
		expect(getCachedResponseBody(listKey)).toBeUndefined();
	});
});
