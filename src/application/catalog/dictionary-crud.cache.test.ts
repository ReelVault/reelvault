import { afterEach, describe, expect, test } from "bun:test";
import { genreRepository } from "@/database/repositories/genres.repository";
import { getCachedResponseBody, responseCacheKey, setCachedResponseBody } from "@/utils/response-body-cache";
import { stubMethod } from "../../../tests/helpers/method-stub";
import { genresService } from "./genres.service";

/**
 * Genre, company and keyword edits change what the cached catalog lists embed, so every write has to
 * drop the cached list responses. The shared CRUD base does that for all of them; genres exercise it.
 */

const stubs: Array<{ restore(): void }> = [];
afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
});

const listKey = responseCacheKey({ pathWithQuery: "/v1/genres?limit=20", cookie: "", profileId: "", auth: "", apiKey: "" });

function seedCachedList(): void {
	setCachedResponseBody(listKey, { etag: "e", body: "[]", expiresAt: Date.now() + 60_000, encoded: new Map() });
	expect(getCachedResponseBody(listKey)).toBeDefined();
}

function stubGenreRepository(): void {
	stubs.push(
		stubMethod(genreRepository, "findByIdForRead", (id: string) => Promise.resolve({ id, name: "Drama" })),
		stubMethod(genreRepository, "createAndRead", (body: { name: string }) => Promise.resolve({ id: "g2", name: body.name })),
		stubMethod(genreRepository, "updateAndRead", (id: string, body: { name?: string }) =>
			Promise.resolve({ id, name: body.name ?? "Drama" }),
		),
		stubMethod(genreRepository, "delete", () => Promise.resolve({ changes: 1 })),
	);
}

describe("dictionary writes flush cached catalog lists", () => {
	test("creating an entry", async () => {
		stubGenreRepository();
		seedCachedList();

		await genresService.create({ name: "Comedy" });

		expect(getCachedResponseBody(listKey)).toBeUndefined();
	});

	test("editing an entry", async () => {
		stubGenreRepository();
		seedCachedList();

		await genresService.update("g1", { name: "Drama (renamed)" });

		expect(getCachedResponseBody(listKey)).toBeUndefined();
	});

	test("deleting an entry", async () => {
		stubGenreRepository();
		seedCachedList();

		await genresService.delete("g1");

		expect(getCachedResponseBody(listKey)).toBeUndefined();
	});
});
