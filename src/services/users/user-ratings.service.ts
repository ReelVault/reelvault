import type {
	FieldsQuery,
	PaginatedResponse,
	PaginationQuery,
	SelectFields,
	UserRating,
	UserRatingFilters,
	UserRatingSorting,
} from "@reelvault/sdk/common";
import { userRatingsRepository } from "@/repositories/user-ratings.repository";
import { assertFound, assertProfileId } from "@/utils/domain.errors";
import { createLogger } from "@/utils/logger.utils";
import { runSafely } from "@/utils/safe-execute.utils";

import { invalidateProfileCaches } from "./cache-invalidation.cache";
import { assertMetadataExists } from "./metadata-existence.utils";

export const userRatingsService = {
	serviceName: "UserRatingsService",
	logger: createLogger("UserRatingsService"),

	async getRatings<F extends string>(
		query?: PaginationQuery & FieldsQuery<F> & UserRatingFilters & UserRatingSorting,
		profileId?: string,
	): Promise<PaginatedResponse<SelectFields<UserRating, F>>> {
		return await runSafely(userRatingsService, "getRatings", async () => {
			assertProfileId(profileId);

			return await userRatingsRepository.findPage({ ...query, profileId });
		});
	},

	async rate(body: { metadataId: string; rating: number }, profileId?: string): Promise<UserRating> {
		return await runSafely(userRatingsService, "rate", async () => {
			assertProfileId(profileId);

			// awaits: sequential — the catalog id is checked before the rating is written
			await assertMetadataExists([body.metadataId]);

			const result = await userRatingsRepository.upsert({ profileId, metadataId: body.metadataId, rating: body.rating });
			assertFound(result, "UserRating", body.metadataId);
			invalidateProfileCaches(profileId);

			return result;
		});
	},

	async delete(metadataId: string, profileId?: string): Promise<{ success: boolean }> {
		return await runSafely(userRatingsService, "delete", async () => {
			assertProfileId(profileId);
			await userRatingsRepository.deleteForProfileMetadata({ profileId, metadataId });
			invalidateProfileCaches(profileId);

			return { success: true };
		});
	},
};
