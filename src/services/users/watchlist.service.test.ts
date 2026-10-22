import { describe, expect, test } from "bun:test";
import { HydratedWatchlistItemSchema, PaginatedResponseSchema } from "@reelvault/sdk/common";
import { Value } from "@sinclair/typebox/value";
import { insertMetadata, insertProfiles, insertUsers, selectWatchlist } from "../../../tests/helpers/rows.fixture";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { watchlistService } from "./watchlist.service";

const db = useTestDatabase();

async function seedProfileWithTitles(titleIds: string[]): Promise<void> {
	const client = db.client();
	await insertUsers(client, { id: "user-1", name: "User", email: "user@example.com", emailVerified: true });
	await insertProfiles(client, { id: "profile-1", userId: "user-1", name: "Default" });
	for (const id of titleIds) {
		await insertMetadata(client, { id, stableKey: id, title: `Title ${id}`, type: "movie", releaseDate: "2020-01-01" });
	}
}

async function watchlistMetadataIds(): Promise<string[]> {
	const rows = await selectWatchlist(db.client());

	return rows.map((row) => row.metadataId).toSorted();
}

describe("WatchlistService getAll", () => {
	test("hydrated items carry the title even when the request projects the list fields", async () => {
		await seedProfileWithTitles(["metadata-1"]);
		await watchlistService.toggle({ metadataId: "metadata-1" }, "profile-1");

		const result = await watchlistService.getAll({ fields: "id,metadataId,createdAt", hydrate: true }, "profile-1");

		// The hydrated branch requires profileId/updatedAt — a projection would 400 the response.
		expect(result.data).toEqual([
			expect.objectContaining({
				profileId: "profile-1",
				metadataId: "metadata-1",
				metadata: expect.objectContaining({ id: "metadata-1", title: "Title metadata-1" }),
			}),
		]);
	});

	test("hydrated responses satisfy the response union schema", async () => {
		// The route validates against this union — a projection that drops
		// profileId/updatedAt used to fail response validation with a cryptic 400.
		await seedProfileWithTitles(["metadata-1"]);
		await watchlistService.toggle({ metadataId: "metadata-1" }, "profile-1");

		const result = await watchlistService.getAll({ fields: "id,metadataId,createdAt", hydrate: true }, "profile-1");

		expect(Value.Check(PaginatedResponseSchema(HydratedWatchlistItemSchema), result)).toBeTrue();
	});
});

describe("WatchlistService toggle", () => {
	test("an unknown title is a 404, not an FK violation", async () => {
		await seedProfileWithTitles([]);

		await expect(watchlistService.toggle({ metadataId: "metadata-missing" }, "profile-1")).rejects.toMatchObject({
			code: "entity.not_found",
			params: { entityType: "Metadata", entityId: "metadata-missing" },
		});
		expect(await watchlistMetadataIds()).toEqual([]);
	});
});

describe("WatchlistService bulk update and clear", () => {
	test("adds the catalog titles once and removes the listed ones in one batch", async () => {
		await seedProfileWithTitles(["metadata-1", "metadata-2", "metadata-3"]);
		await watchlistService.toggle({ metadataId: "metadata-3" }, "profile-1");

		const result = await watchlistService.bulkUpdate(
			{ add: ["metadata-1", "metadata-2", "metadata-1"], remove: ["metadata-3"] },
			"profile-1",
		);

		expect(result).toEqual({ success: true, added: 2, removed: 1 });
		expect(await watchlistMetadataIds()).toEqual(["metadata-1", "metadata-2"]);
	});

	test("refuses the whole batch when one title is missing from the catalog", async () => {
		await seedProfileWithTitles(["metadata-1"]);

		await expect(watchlistService.bulkUpdate({ add: ["metadata-1", "metadata-missing"] }, "profile-1")).rejects.toMatchObject({
			code: "entity.not_found",
			params: { entityType: "Metadata", entityId: "metadata-missing" },
		});
		expect(await watchlistMetadataIds()).toEqual([]);
	});

	test("rejects a title that is both added and removed, and changes nothing", async () => {
		await seedProfileWithTitles(["metadata-1"]);

		await expect(watchlistService.bulkUpdate({ add: ["metadata-1"], remove: ["metadata-1"] }, "profile-1")).rejects.toMatchObject({
			code: "watchlist.bulk_conflict",
		});
		expect(await watchlistMetadataIds()).toEqual([]);
	});
});
