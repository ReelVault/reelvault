import type {
	FieldsQuery,
	PaginatedResponse,
	PaginationQuery,
	SelectFields,
	UserRating,
	UserRatingFilters,
	UserRatingSorting,
} from "@reelvault/sdk/common";
import { invalidateProfileResponseBodies } from "@/api/utils/etag.utils";
import { userRatingsRepository } from "@/database/repositories/user-ratings.repository";
import { BaseService } from "@/utils/base-service";

import { discoverService } from "./discover.service";

class UserRatingsService extends BaseService {
	constructor() {
		super("UserRatingsService");
	}

	async getRatings<F extends string>(
		query?: PaginationQuery & FieldsQuery<F> & UserRatingFilters & UserRatingSorting,
		profileId?: string,
	): Promise<PaginatedResponse<SelectFields<UserRating, F>>> {
		return await this.safeExecute("getRatings", async () => {
			this.assertProfileId(profileId);

			return await userRatingsRepository.findPage({ ...query, profileId });
		});
	}

	async rate(body: { metadataId: string; rating: number }, profileId?: string): Promise<UserRating> {
		return await this.safeExecute("rate", async () => {
			this.assertProfileId(profileId);
			const result = await userRatingsRepository.upsertInTransaction({ profileId, metadataId: body.metadataId, rating: body.rating });
			this.assertExists(result, "UserRating", body.metadataId);
			discoverService.clearCache(profileId);
			invalidateProfileResponseBodies(profileId);

			return result;
		});
	}

	async delete(metadataId: string, profileId?: string): Promise<{ success: boolean }> {
		return await this.safeExecute("delete", async () => {
			this.assertProfileId(profileId);
			await userRatingsRepository.deleteForProfileMetadata({ profileId, metadataId });
			discoverService.clearCache(profileId);
			invalidateProfileResponseBodies(profileId);

			return { success: true };
		});
	}
}

export const userRatingsService = new UserRatingsService();
