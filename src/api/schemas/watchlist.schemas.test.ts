import { expect, test } from "bun:test";
import { HydratedWatchlistItemSchema, ProjectedResponseSchema, WatchlistSchema } from "@reelvault/sdk/common";
import { Value } from "@sinclair/typebox/value";
import { t } from "elysia";
import { PaginatedResponseSchema } from "./common.schemas";
import { watchlistResponseSchema } from "./watchlist.schemas";

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
	expect(cleaned.data[0]?.metadata).toBeDefined();
});

test("the branch order is what preserves the card", () => {
	// The old order — projected first — matched hydrated items too and the
	// normalization stripped the embedded metadata (the watchlist page bug).
	const reversed = t.Union([
		PaginatedResponseSchema(ProjectedResponseSchema(WatchlistSchema)),
		PaginatedResponseSchema(HydratedWatchlistItemSchema),
	]);
	const cleanedReversed = Value.Clean(reversed, hydratedPage()) as CleanedPage;
	expect(cleanedReversed.data[0]?.metadata).toBeUndefined();

	const cleanedCurrent = Value.Clean(watchlistResponseSchema, hydratedPage()) as CleanedPage;
	expect(cleanedCurrent.data[0]?.metadata).toBeDefined();
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
