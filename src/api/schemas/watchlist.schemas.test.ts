import { expect, test } from "bun:test";
import { HydratedWatchlistItemSchema } from "@reelvault/sdk/common";
import { Value } from "@sinclair/typebox/value";
import { watchlistResponseSchema } from "./watchlist.schema";

interface CleanedPage {
	data: Array<Record<string, unknown>>;
}

function hydratedPage(): { data: unknown[]; page: number; limit: number; total: number; totalPages: number } {
	const item = Value.Create(HydratedWatchlistItemSchema);

	return { data: [item], page: 1, limit: 20, total: 1, totalPages: 1 };
}

test("hydrated items keep their metadata card through response normalization", () => {
	const page = hydratedPage();

	expect(Value.Check(watchlistResponseSchema, page)).toBeTrue();

	const cleaned = Value.Clean(watchlistResponseSchema, page) as CleanedPage;
	expect<unknown>(cleaned.data[0]).toEqual(page.data[0]);
});

test("projected items without hydration still validate", () => {
	const item = Value.Create(HydratedWatchlistItemSchema);
	const page = {
		data: [{ id: item.id, metadataId: item.metadataId, createdAt: item.createdAt }],
		page: 1,
		limit: 20,
		total: 1,
		totalPages: 1,
	};

	expect(Value.Check(watchlistResponseSchema, page)).toBeTrue();
	const cleaned = Value.Clean(watchlistResponseSchema, page) as CleanedPage;
	expect(cleaned.data[0]?.metadata).toBeUndefined();
	expect(cleaned.data[0]?.id).toBe(item.id);
});
