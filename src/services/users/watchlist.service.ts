import type {
	CreateWatchlist,
	FieldsQuery,
	HydratedWatchlistItem,
	PaginatedResponse,
	PaginationQuery,
	SelectFields,
	Watchlist,
	WatchlistBulkBody,
	WatchlistFilters,
	WatchlistSorting,
} from "@reelvault/sdk/common";
import { metadataRepository } from "@/repositories/metadata.repository";
import { watchlistRepository } from "@/repositories/watchlist.repository";
import { toMap, unique } from "@/utils/array.utils";
import { assertExists, assertProfileId, DomainError } from "@/utils/domain.errors";
import { createLogger } from "@/utils/logger.utils";
import { runSafely } from "@/utils/safe-execute.utils";
import { isNotNullish } from "@/utils/type.utils";

import { invalidateProfileCaches } from "./cache-invalidation.cache";

/** Hard cap for batch status checks (guards against giant query strings). */
export const MAX_STATUSES_IDS = 500;

class WatchlistService {
	readonly serviceName = "WatchlistService";
	readonly logger = createLogger("WatchlistService");

	async getAll<F extends string>(
		query?: PaginationQuery & FieldsQuery<F> & WatchlistFilters & WatchlistSorting & { hydrate?: boolean },
		profileId?: string,
	): Promise<PaginatedResponse<SelectFields<Watchlist, F>> | PaginatedResponse<HydratedWatchlistItem>> {
		return await runSafely(this, "getAll", async () => {
			assertProfileId(profileId);
			const { hydrate, fields, ...pageQuery } = query ?? {};
			// Hydration returns full watchlist rows plus their metadata cards; a field
			// projection would drop `profileId`/`updatedAt`, which the hydrated
			// response schema requires — so `fields` is ignored in that mode.
			const page = await watchlistRepository.findPage({
				...pageQuery,
				...(hydrate || fields === undefined ? {} : { fields }),
				profileId,
			});
			if (!hydrate || page.data.length === 0) return page;

			// One batched card fetch replaces the client's second request (the old
			// list→metadata waterfall). Titles missing their metadata row (deleted
			// from the catalog) drop out, matching what the hydration used to return.
			const cards = await metadataRepository.findManyByIdsWithRelations(unique(page.data.map((item) => item.metadataId)));
			const cardsById = toMap(cards, (card) => card.id);
			const data = page.data
				.map((item) => {
					const metadata = cardsById.get(item.metadataId);
					return metadata ? { ...item, metadata } : undefined;
				})
				.filter((item) => isNotNullish(item));

			return { ...page, data };
		});
	}

	async add(metadataId: string, profileId?: string) {
		return await runSafely(this, "add", async () => {
			assertProfileId(profileId);
			// awaits: sequential — the metadata must exist before it is added to the watchlist
			await this.assertMetadataExists(metadataId);

			await watchlistRepository.insert({ values: { profileId, metadataId } });
			invalidateProfileCaches(profileId);

			return { success: true as const, added: true as const };
		});
	}

	async remove(metadataId: string, profileId?: string) {
		return await runSafely(this, "remove", async () => {
			assertProfileId(profileId);

			await watchlistRepository.remove(profileId, metadataId);
			invalidateProfileCaches(profileId);

			return { success: true as const, removed: true as const };
		});
	}

	/**
	 * Adds and removes several titles in one request. A title missing from the catalog
	 * refuses the whole batch, so a stale id cannot leave it half applied.
	 */
	async bulkUpdate(body: WatchlistBulkBody, profileId?: string) {
		return await runSafely(this, "bulkUpdate", async () => {
			assertProfileId(profileId);
			const add = unique(body.add ?? []);
			const remove = unique(body.remove ?? []);
			const removing = new Set(remove);
			const both = add.find((metadataId) => removing.has(metadataId));
			if (both !== undefined) {
				throw new DomainError("validation", "A title cannot be added and removed in the same request", {
					code: "watchlist.bulk_conflict",
					params: { metadataId: both },
				});
			}

			// awaits: sequential — a failed insert stops the removal, so the list is never half-updated
			await this.assertMetadataExistAll(add);
			const added = await watchlistRepository.insertMany(profileId, add);
			const removed = await watchlistRepository.removeMany(profileId, remove);
			invalidateProfileCaches(profileId);

			return { success: true as const, added, removed };
		});
	}

	async clear(profileId?: string) {
		return await runSafely(this, "clear", async () => {
			assertProfileId(profileId);

			const removed = await watchlistRepository.clear(profileId);
			invalidateProfileCaches(profileId);

			return { success: true as const, removed };
		});
	}

	async isWatchlisted(metadataId: string, profileId?: string) {
		return await runSafely(this, "isWatchlisted", async () => {
			if (!profileId) return { inWatchlist: false };

			const exists = await watchlistRepository.isWatchlisted(profileId, metadataId);

			return { inWatchlist: exists };
		});
	}

	async getStatuses(metadataIds: string[], profileId?: string): Promise<{ statuses: Array<{ metadataId: string; inWatchlist: boolean }> }> {
		return await runSafely(this, "getStatuses", async () => {
			const uniqueIds = unique(metadataIds).slice(0, MAX_STATUSES_IDS);
			if (!profileId || uniqueIds.length === 0) {
				return { statuses: uniqueIds.map((metadataId) => ({ metadataId, inWatchlist: false })) };
			}

			const watchlisted = await watchlistRepository.findWatchlistedIds(profileId, uniqueIds);

			return { statuses: uniqueIds.map((metadataId) => ({ metadataId, inWatchlist: watchlisted.has(metadataId) })) };
		});
	}

	async toggle(body: CreateWatchlist, profileId?: string) {
		return await runSafely(this, "toggle", async () => {
			assertProfileId(profileId);
			// awaits: sequential — the metadata must exist before the watchlist is toggled
			await this.assertMetadataExists(body.metadataId);

			const result = await watchlistRepository.toggle({ metadataId: body.metadataId, profileId });
			invalidateProfileCaches(profileId);

			return result;
		});
	}

	/** Every id must exist in the catalog; the first missing one is reported. */
	private async assertMetadataExistAll(metadataIds: readonly string[]): Promise<void> {
		const existing = await metadataRepository.findExistingIds(metadataIds);
		const missing = metadataIds.find((metadataId) => !existing.has(metadataId));
		assertExists(missing === undefined, "Metadata", missing);
	}

	/** A stale catalog id must be a 404, not an FK violation surfacing as a 500. */
	private async assertMetadataExists(metadataId: string): Promise<void> {
		// The existence check needs no relation graph — the full read would load
		// the cast, crew, genres and providers of the title for a yes/no answer.
		const existing = await metadataRepository.findExistingIds([metadataId]);
		assertExists(existing.has(metadataId), "Metadata", metadataId);
	}
}

export const watchlistService = new WatchlistService();
