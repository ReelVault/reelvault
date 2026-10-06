import type {
	FieldsQuery,
	PaginatedResponse,
	PaginationQuery,
	SelectFields,
	UserRating,
	UserRatingFilters,
	UserRatingSorting,
} from "@reelvault/sdk/common";
import { and, eq } from "drizzle-orm";
import { databaseFactory } from "@/database/database";
import { defineRepository, defineTableAccess, findPageWithQueryMap } from "@/database/table-access";
import type { DatabaseTransaction } from "@/database/types";
import { QueryFiltering } from "@/database/utils/filtering";
import type { QueryMap } from "@/database/utils/query-parser";

const userRatings = defineTableAccess("userRatings", {
	primaryKeyColumn: "id",
});

const userRatingQueryMap: QueryMap<UserRatingFilters, UserRatingSorting> = {
	filters: {
		profileId: (value: string) => QueryFiltering.eq(userRatings.table.profileId, value),
		metadataId: (value: string) => QueryFiltering.eq(userRatings.table.metadataId, value),
		rating: (value: number) => QueryFiltering.eq(userRatings.table.rating, value),
	},
	orderBy: {
		rating: userRatings.table.rating,
		createdAt: userRatings.table.createdAt,
		updatedAt: userRatings.table.updatedAt,
	},
	defaults: { sortBy: "createdAt", sortOrder: "desc" },
};

const overrides = {
	/** The profile's rating for a metadata row, if any. */
	async findByProfileAndMetadata(profileId: string, metadataId: string) {
		return await getUserRatingsRepository().selectFirst({
			where: and(eq(userRatings.table.profileId, profileId), eq(userRatings.table.metadataId, metadataId)),
		});
	},

	async upsert({ profileId, metadataId, rating, tx }: { profileId: string; metadataId: string; rating: number; tx?: DatabaseTransaction }) {
		const [result] = await databaseFactory
			.getClient({ tx })
			.insert(userRatings.table)
			.values({ profileId, metadataId, rating })
			.onConflictDoUpdate({
				target: [userRatings.table.profileId, userRatings.table.metadataId],
				set: { rating, updatedAt: new Date() },
			})
			.returning();

		return result;
	},

	async findPage<F extends string>(
		query?: PaginationQuery & FieldsQuery<F> & UserRatingFilters & UserRatingSorting,
	): Promise<PaginatedResponse<SelectFields<UserRating, F>>> {
		return await findPageWithQueryMap({
			access: userRatings,
			queryMap: userRatingQueryMap,
			query,
			findMany: (params) => userRatings.findMany<F>(params),
		});
	},

	async deleteForProfileMetadata({ profileId, metadataId, tx }: { profileId: string; metadataId: string; tx?: DatabaseTransaction }) {
		await getUserRatingsRepository().delete({
			where: and(eq(userRatings.table.profileId, profileId), eq(userRatings.table.metadataId, metadataId)),
			tx,
		});
	},
};

export const userRatingsRepository = defineRepository(userRatings, overrides);

/** Methods dispatch through the singleton so tests can monkey-patch delegations. */
function getUserRatingsRepository() {
	return userRatingsRepository;
}
