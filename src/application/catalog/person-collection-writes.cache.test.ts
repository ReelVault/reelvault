import { afterEach, describe, expect, test } from "bun:test";
import { collectionRepository } from "@/database/repositories/collections.repository";
import { peopleRepository } from "@/database/repositories/people.repository";
import { getCachedResponseBody, responseCacheKey, setCachedResponseBody } from "@/utils/response-body-cache";
import { stubMethod } from "../../../tests/helpers/method-stub";
import { collectionsService } from "./collections.service";
import { peopleService } from "./people.service";

/**
 * People and collections share the dictionary write base with genres, but they are the two lists the
 * catalog embeds in titles and collection pages. Each write has to drop the cached list responses of its own
 * path, so a stale list is never served after a create, an edit or a delete.
 */

const stubs: Array<{ restore(): void }> = [];
afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
});

const peopleListKey = responseCacheKey({ pathWithQuery: "/v1/people?limit=20", cookie: "", profileId: "", auth: "", apiKey: "" });
const collectionsListKey = responseCacheKey({ pathWithQuery: "/v1/collections?limit=20", cookie: "", profileId: "", auth: "", apiKey: "" });

function seedCachedList(key: string): void {
	setCachedResponseBody(key, { etag: "e", body: "[]", expiresAt: Date.now() + 60_000, encoded: new Map() });
	expect(getCachedResponseBody(key)).toBeDefined();
}

function stubPeopleRepository(): void {
	stubs.push(
		stubMethod(peopleRepository, "findByIdForRead", (id: string) => Promise.resolve({ id, name: "Ann" })),
		stubMethod(peopleRepository, "createAndRead", (body: { name: string }) => Promise.resolve({ id: "p2", name: body.name })),
		stubMethod(peopleRepository, "updateAndRead", (id: string, body: { name?: string }) =>
			Promise.resolve({ id, name: body.name ?? "Ann" }),
		),
		stubMethod(peopleRepository, "delete", () => Promise.resolve({ changes: 1 })),
	);
}

function stubCollectionRepository(): void {
	stubs.push(
		stubMethod(collectionRepository, "findByIdForRead", (id: string) => Promise.resolve({ id, name: "Saga" })),
		stubMethod(collectionRepository, "delete", () => Promise.resolve({ changes: 1 })),
	);
}

describe("person writes flush cached people lists", () => {
	test("creating a person", async () => {
		stubPeopleRepository();
		seedCachedList(peopleListKey);

		await peopleService.create({ name: "Bea" });

		expect(getCachedResponseBody(peopleListKey)).toBeUndefined();
	});

	test("editing a person", async () => {
		stubPeopleRepository();
		seedCachedList(peopleListKey);

		await peopleService.update("p1", { name: "Ann (renamed)" });

		expect(getCachedResponseBody(peopleListKey)).toBeUndefined();
	});

	test("deleting a person", async () => {
		stubPeopleRepository();
		seedCachedList(peopleListKey);

		await peopleService.delete("p1");

		expect(getCachedResponseBody(peopleListKey)).toBeUndefined();
	});
});

describe("collection writes flush cached collection lists", () => {
	test("deleting a collection", async () => {
		stubCollectionRepository();
		seedCachedList(collectionsListKey);

		await collectionsService.delete("c1");

		expect(getCachedResponseBody(collectionsListKey)).toBeUndefined();
	});
});
