import { afterEach, expect, test } from "bun:test";
import { genreRepository } from "@/database/repositories/genres.repository";
import { getCachedResponseBody, responseCacheKey, setCachedResponseBody } from "@/utils/response-body-cache";
import { stubMethod } from "../../../tests/helpers/method-stub";
import { genresService } from "./genres.service";

const stubs: Array<{ restore(): void }> = [];
afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
});

const key = responseCacheKey({ pathWithQuery: "/v1/genres?page=1", cookie: "", profileId: "", auth: "", apiKey: "" });

function stubRepository(): void {
	stubs.push(
		stubMethod(genreRepository, "findByIdForRead", (id: string) => Promise.resolve({ id, name: "Drama" })),
		stubMethod(genreRepository, "createAndRead", (body: { name: string }) => Promise.resolve({ id: "g1", name: body.name })),
		stubMethod(genreRepository, "updateAndRead", (id: string, body: { name: string }) => Promise.resolve({ id, name: body.name })),
		stubMethod(genreRepository, "delete", () => Promise.resolve()),
	);
}

test.each([
	["create", () => genresService.create({ name: "Drama" })],
	["update", () => genresService.update("g1", { name: "Comedy" })],
	["delete", () => genresService.delete("g1")],
])("%s flushes the cached catalog lists", async (_name, write) => {
	stubRepository();
	setCachedResponseBody(key, { etag: "e", body: "{}", expiresAt: Date.now() + 60_000, encoded: new Map() });
	expect(getCachedResponseBody(key)).toBeDefined();

	await write();

	expect(getCachedResponseBody(key)).toBeUndefined();
});
