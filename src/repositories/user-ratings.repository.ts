import type { UserRatingFilters, UserRatingSorting } from "@reelvault/sdk/common";
import { and, eq } from "drizzle-orm";
import type { DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import { filterEquals } from "@/integrations/drizzle-orm/query/parsing/filtering.parser";
import type { QueryMap } from "@/integrations/drizzle-orm/query/parsing/query.parser";
import { definePagedFind } from "@/integrations/drizzle-orm/query/table-access/reads.reader";
import { defineRepository, defineTableAccess } from "@/integrations/drizzle-orm/query/table-access/table-access.factory";

const userRatings = defineTableAccess("userRatings", {
	primaryKeyColumn: "id",
});

const userRatingQueryMap: QueryMap<UserRatingFilters, UserRatingSorting> = {
	filters: {
		profileId: (value: string) => filterEquals(userRatings.table.profileId, value),
		metadataId: (value: string) => filterEquals(userRatings.table.metadataId, value),
		rating: (value: number) => filterEquals(userRatings.table.rating, value),
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
		const [result] = await userRatings.upsert({
			values: { profileId, metadataId, rating },
			target: [userRatings.table.profileId, userRatings.table.metadataId],
			set: { rating, updatedAt: new Date() },
			returning: true,
			tx,
		});

		return result;
	},

	findPage: definePagedFind({
		access: userRatings,
		queryMap: userRatingQueryMap,
		findMany: (params) => userRatings.findMany(params),
	}),

	async deleteForProfileMetadata({ profileId, metadataId, tx }: { profileId: string; metadataId: string; tx?: DatabaseTransaction }) {
		await getUserRatingsRepository().delete({
			where: and(eq(userRatings.table.profileId, profileId), eq(userRatings.table.metadataId, metadataId)),
			tx,
		});
	},
};

export const userRatingsRepository = defineRepository(userRatings, overrides);

/** Methods dispatch through the singleton: the lint rule forbids referencing the const before its definition. */
function getUserRatingsRepository() {
	return userRatingsRepository;
}
