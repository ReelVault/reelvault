import type {
	FieldsQuery,
	PaginatedResponse,
	PaginationQuery,
	SelectFields,
	UserRating,
	UserRatingFilters,
	UserRatingSorting,
} from "@reelvault/sdk/common";
import { metadataRepository } from "@/repositories/metadata.repository";
import { userRatingsRepository } from "@/repositories/user-ratings.repository";
import { assertExists, assertFound, assertProfileId } from "@/utils/domain.errors";
import { createLogger } from "@/utils/logger.utils";
import { runSafely } from "@/utils/safe-execute.utils";

import { invalidateProfileCaches } from "./cache-invalidation.cache";

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

			// A stale catalog id must be a 404, not an FK violation surfacing as a 500.
			// The existence check needs no relation graph — the full read would load
			// the cast, crew, genres and providers of the title for a yes/no answer.
			const existing = await metadataRepository.findExistingIds([body.metadataId]);
			assertExists(existing.has(body.metadataId), "Metadata", body.metadataId);

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
