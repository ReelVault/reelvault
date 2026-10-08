import { HydratedWatchlistItemSchema, ProjectedResponseSchema, WatchlistSchema } from "@reelvault/sdk/common";
import { t } from "elysia";
import { PaginatedResponseSchema } from "./common.schemas";

/** Projected list contract — shared by the route model registry and the union below. */
export const watchlistPaginatedSchema = PaginatedResponseSchema(ProjectedResponseSchema(WatchlistSchema));

/** Hydrated list contract — the `?hydrate=true` payload shape. */
export const hydratedWatchlistPaginatedSchema = PaginatedResponseSchema(HydratedWatchlistItemSchema);

/**
 * Response union for `GET /me/watchlist`.
 *
 * Order matters: the response pipeline normalizes through the FIRST matching
 * union member, and the deep-partial projected branch also matches hydrated
 * items — with the projected schema first it silently stripped the embedded
 * `metadata` card from every hydrated item.
 */
export const watchlistResponseSchema = t.Union([hydratedWatchlistPaginatedSchema, watchlistPaginatedSchema]);
