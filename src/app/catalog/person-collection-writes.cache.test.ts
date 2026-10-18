import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getCachedResponseBody, invalidateResponseBodies, responseCacheKey, setCachedResponseBody } from "@/utils/response-body.cache";
import { insertCollections, insertPeople, selectCollections, selectPeople } from "../../../tests/helpers/rows.fixture";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { collectionsService } from "./collections.service";
import { peopleService } from "./people.service";

/**
 * People and collections share the dictionary write base with genres, but they are the two lists the
 * catalog embeds in titles and collection pages. Each write has to drop the cached list responses of its own
 * path, so a stale list is never served after a create, an edit or a delete.
 */

const { client } = useTestDatabase();

const peopleListKey = responseCacheKey({ pathWithQuery: "/v1/people?limit=20", cookie: "", profileId: "", auth: "", apiKey: "" });
const collectionsListKey = responseCacheKey({ pathWithQuery: "/v1/collections?limit=20", cookie: "", profileId: "", auth: "", apiKey: "" });

function seedCachedList(key: string): void {
	setCachedResponseBody(key, { etag: "e", body: "[]", expiresAt: Date.now() + 60_000, encoded: new Map() });
}

beforeEach(async () => {
	await insertPeople(client(), { id: "p1", stableKey: "person:ann", name: "Ann" });
	await insertCollections(client(), { id: "c1", stableKey: "collection:saga", name: "Saga" });
});

afterEach(() => {
	invalidateResponseBodies();
});

describe("person writes flush cached people lists", () => {
	test("creating a person stores it and drops the cached people lists", async () => {
		seedCachedList(peopleListKey);

		await peopleService.create({ name: "Bea" });

		expect((await selectPeople(client())).map((row) => row.name)).toContain("Bea");
		expect(getCachedResponseBody(peopleListKey)).toBeUndefined();
	});

	test("renaming a person stores the new name and drops the cached people lists", async () => {
		seedCachedList(peopleListKey);

		await peopleService.update("p1", { name: "Ann (renamed)" });

		expect((await selectPeople(client())).map((row) => row.name)).toEqual(["Ann (renamed)"]);
		expect(getCachedResponseBody(peopleListKey)).toBeUndefined();
	});

	test("deleting a person removes it and drops the cached people lists", async () => {
		seedCachedList(peopleListKey);

		await peopleService.delete("p1");

		expect(await selectPeople(client())).toEqual([]);
		expect(getCachedResponseBody(peopleListKey)).toBeUndefined();
	});
});

describe("collection writes flush cached collection lists", () => {
	test("deleting a collection removes it and drops the cached collection lists", async () => {
		seedCachedList(collectionsListKey);

		await collectionsService.delete("c1");

		expect(await selectCollections(client())).toEqual([]);
		expect(getCachedResponseBody(collectionsListKey)).toBeUndefined();
	});
});
