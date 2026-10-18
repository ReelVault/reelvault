import type {
	FieldsQuery,
	PaginatedResponse,
	PaginationQuery,
	SelectFields,
	UserRating,
	UserRatingFilters,
	UserRatingSorting,
} from "@reelvault/sdk/common";
import { metadataRepository } from "@/app/repositories/metadata.repository";
import { userRatingsRepository } from "@/app/repositories/user-ratings.repository";
import { assertFound, assertProfileId } from "@/utils/domain.errors";
import { createLogger } from "@/utils/logger.utils";
import { runSafely } from "@/utils/safe-execute.utils";

import { invalidateProfileCaches } from "./cache-invalidation.cache";

class UserRatingsService {
	readonly serviceName = "UserRatingsService";
	readonly logger = createLogger("UserRatingsService");

	async getRatings<F extends string>(
		query?: PaginationQuery & FieldsQuery<F> & UserRatingFilters & UserRatingSorting,
		profileId?: string,
	): Promise<PaginatedResponse<SelectFields<UserRating, F>>> {
		return await runSafely(this, "getRatings", async () => {
			assertProfileId(profileId);

			return await userRatingsRepository.findPage({ ...query, profileId });
		});
	}

	async rate(body: { metadataId: string; rating: number }, profileId?: string): Promise<UserRating> {
		return await runSafely(this, "rate", async () => {
			assertProfileId(profileId);

			// A stale catalog id must be a 404, not an FK violation surfacing as a 500.
			const metadata = await metadataRepository.findByIdForRead(body.metadataId);
			assertFound(metadata, "Metadata", body.metadataId);

			const result = await userRatingsRepository.upsert({ profileId, metadataId: body.metadataId, rating: body.rating });
			assertFound(result, "UserRating", body.metadataId);
			invalidateProfileCaches(profileId);

			return result;
		});
	}

	async delete(metadataId: string, profileId?: string): Promise<{ success: boolean }> {
		return await runSafely(this, "delete", async () => {
			assertProfileId(profileId);
			await userRatingsRepository.deleteForProfileMetadata({ profileId, metadataId });
			invalidateProfileCaches(profileId);

			return { success: true };
		});
	}
}

export const userRatingsService = new UserRatingsService();
