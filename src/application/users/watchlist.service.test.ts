import { afterEach, describe, expect, test } from "bun:test";
import { metadataRepository } from "@/database/repositories/metadata.repository";
import { watchlistRepository } from "@/database/repositories/watchlist.repository";
import { stubMethod } from "../../../tests/helpers/method-stub";
import { watchlistService } from "./watchlist.service";

const activeStubs: Array<{ restore(): void }> = [];

afterEach(() => {
	for (const stub of activeStubs.splice(0)) stub.restore();
});

function createPage() {
	return {
		data: [{ id: "watch-1", profileId: "profile-1", metadataId: "metadata-1", createdAt: new Date(), updatedAt: new Date() }],
		page: 1,
		limit: 20,
		total: 1,
		totalPages: 1,
	};
}

describe("WatchlistService getAll", () => {
	test("hydrate=true ignores the fields projection so the hydrated response schema can match", async () => {
		let captured: Record<string, unknown> | undefined;
		activeStubs.push(
			stubMethod(watchlistRepository, "findPage", (params: Record<string, unknown>) => {
				captured = params;

				return Promise.resolve(createPage());
			}),
			stubMethod(metadataRepository, "findManyByIdsWithRelations", () => Promise.resolve([{ id: "metadata-1" }])),
		);

		const result = await watchlistService.getAll({ fields: "id,metadataId,createdAt", hydrate: true }, "profile-1");

		// The hydrated branch requires profileId/updatedAt — a projection would 400 the response.
		expect(captured?.fields).toBeUndefined();
		expect(result.data[0]).toMatchObject({ id: "watch-1", profileId: "profile-1", metadata: { id: "metadata-1" } });
	});

	test("without hydration the fields projection is passed through", async () => {
		let captured: Record<string, unknown> | undefined;
		activeStubs.push(
			stubMethod(watchlistRepository, "findPage", (params: Record<string, unknown>) => {
				captured = params;

				return Promise.resolve(createPage());
			}),
		);

		await watchlistService.getAll({ fields: "id,metadataId", hydrate: false }, "profile-1");

		expect(captured?.fields).toBe("id,metadataId");
	});
});
