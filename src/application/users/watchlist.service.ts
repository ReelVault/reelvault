import type {
	CreateWatchlist,
	FieldsQuery,
	HydratedWatchlistItem,
	PaginatedResponse,
	PaginationQuery,
	SelectFields,
	Watchlist,
	WatchlistFilters,
	WatchlistSorting,
} from "@reelvault/sdk/common";
import { metadataRepository } from "@/database/repositories/metadata.repository";
import { watchlistRepository } from "@/database/repositories/watchlist.repository";
import { isNotNullish, toMap, unique } from "@/utils/array.utils";
import { BaseService } from "@/utils/base-service";
import { invalidateProfileResponseBodies } from "@/utils/response-body-cache";

import { discoverService } from "./discover.service";

/** Hard cap for batch status checks (guards against giant query strings). */
const MAX_STATUSES_IDS = 500;

class WatchlistService extends BaseService {
	constructor() {
		super("WatchlistService");
	}

	async getAll<F extends string>(
		query?: PaginationQuery & FieldsQuery<F> & WatchlistFilters & WatchlistSorting & { hydrate?: boolean },
		profileId?: string,
	): Promise<PaginatedResponse<SelectFields<Watchlist, F>> | PaginatedResponse<HydratedWatchlistItem>> {
		return await this.safeExecute("getAll", async () => {
			this.assertProfileId(profileId);
			const { hydrate, ...pageQuery } = query ?? {};
			const page = await watchlistRepository.findPage({ ...pageQuery, profileId });
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
		return await this.safeExecute("add", async () => {
			this.assertProfileId(profileId);

			await watchlistRepository.insert({ values: { profileId, metadataId } });
			discoverService.clearCache(profileId);
			invalidateProfileResponseBodies(profileId);

			return { success: true as const, added: true as const };
		});
	}

	async remove(metadataId: string, profileId?: string) {
		return await this.safeExecute("remove", async () => {
			this.assertProfileId(profileId);

			await watchlistRepository.remove(profileId, metadataId);
			discoverService.clearCache(profileId);
			invalidateProfileResponseBodies(profileId);

			return { success: true as const, removed: true as const };
		});
	}

	async isWatchlisted(metadataId: string, profileId?: string): Promise<{ inWatchlist: boolean }> {
		return await this.safeExecute("isWatchlisted", async () => {
			if (!profileId) return { inWatchlist: false };

			const exists = await watchlistRepository.isWatchlisted(profileId, metadataId);

			return { inWatchlist: exists };
		});
	}

	async getStatuses(metadataIds: string[], profileId?: string): Promise<{ statuses: Array<{ metadataId: string; inWatchlist: boolean }> }> {
		return await this.safeExecute("getStatuses", async () => {
			const uniqueIds = unique(metadataIds).slice(0, MAX_STATUSES_IDS);
			if (!profileId || uniqueIds.length === 0) {
				return { statuses: uniqueIds.map((metadataId) => ({ metadataId, inWatchlist: false })) };
			}

			const watchlisted = await watchlistRepository.findWatchlistedIds(profileId, uniqueIds);

			return { statuses: uniqueIds.map((metadataId) => ({ metadataId, inWatchlist: watchlisted.has(metadataId) })) };
		});
	}

	async toggle(body: CreateWatchlist, profileId?: string) {
		return await this.safeExecute("toggle", async () => {
			this.assertProfileId(profileId);

			const result = await watchlistRepository.toggle({ metadataId: body.metadataId, profileId });
			discoverService.clearCache(profileId);
			invalidateProfileResponseBodies(profileId);

			return result;
		});
	}
}

export const watchlistService = new WatchlistService();
