import type { FieldsQuery, SelectFields } from "@sdk/common/fields";
import type { PaginatedResponse, PaginationQuery } from "@sdk/common/pagination";
import type { CreateWatchlist, Watchlist, WatchlistFilters, WatchlistSorting } from "@sdk/common/watchlist.types";
import { invalidateProfileResponseBodies } from "@/api/utils/etag.utils";
import { watchlistRepository } from "@/database/repositories/watchlist.repository";
import { unique } from "@/utils/array.utils";
import { BaseService } from "@/utils/base-service";

import { discoverService } from "./discover.service";

/** Hard cap for batch status checks (guards against giant query strings). */
const MAX_STATUSES_IDS = 500;

class WatchlistService extends BaseService {
	constructor() {
		super("WatchlistService");
	}

	async getAll<F extends string>(
		query?: PaginationQuery & FieldsQuery<F> & WatchlistFilters & WatchlistSorting,
		profileId?: string,
	): Promise<PaginatedResponse<SelectFields<Watchlist, F>>> {
		return await this.safeExecute("getAll", async () => {
			this.assertProfileId(profileId);

			return await watchlistRepository.findPage({ ...query, profileId });
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
