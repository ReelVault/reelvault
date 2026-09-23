import type { FieldsConfig, FieldsQuery, SelectFields } from "@sdk/common/fields";
import type { PaginatedResponse, PaginationQuery } from "@sdk/common/pagination";
import type { UserRating, UserRatingFilters, UserRatingSorting } from "@sdk/common/user-ratings.types";
import { and, eq, type SQL } from "drizzle-orm";
import { databaseFactory } from "@/database/database";
import { schema } from "@/database/schema";
import type { ProjectedSelectParams } from "@/database/table-access";
import { defineTableAccess, findPageWithQueryMap, selectFirstWithFields, selectManyWithFields } from "@/database/table-access";
import type { DatabaseTransaction } from "@/database/types";
import { QueryFields } from "@/database/utils/fields";
import { QueryFiltering } from "@/database/utils/filtering";
import type { QueryMap } from "@/database/utils/query-parser";

const userRatings = defineTableAccess("userRatings", {
	primaryKeyColumn: "id",
});

const userRatingQueryMap: QueryMap<UserRatingFilters, UserRatingSorting> = {
	filters: {
		profileId: (value: string) => QueryFiltering.eq(schema.userRatings.profileId, value),
		metadataId: (value: string) => QueryFiltering.eq(schema.userRatings.metadataId, value),
		rating: (value: number) => QueryFiltering.eq(schema.userRatings.rating, value),
	},
	orderBy: {
		rating: schema.userRatings.rating,
		createdAt: schema.userRatings.createdAt,
		updatedAt: schema.userRatings.updatedAt,
	},
	defaults: { sortBy: "createdAt", sortOrder: "desc" },
};

class UserRatingsRepository {
	readonly table = schema.userRatings;
	readonly primaryKeyColumn = userRatings.primaryKeyColumn;
	readonly query = userRatings.query;
	readonly selectMany = userRatings.selectMany;
	readonly selectFirst = userRatings.selectFirst;
	readonly findOrCreate = userRatings.findOrCreate;
	readonly insert = userRatings.insert;
	readonly update = userRatings.update;
	readonly delete = userRatings.delete;
	readonly insertReturning = userRatings.insertReturning;
	readonly updateReturning = userRatings.updateReturning;
	readonly updateAndReturn = userRatings.updateAndReturn;
	readonly deleteReturning = userRatings.deleteReturning;
	readonly deleteAndReturn = userRatings.deleteAndReturn;
	readonly findByIds = userRatings.findByIds;
	readonly findByColumnIn = userRatings.findByColumnIn;
	readonly count = userRatings.count;
	readonly isExists = userRatings.isExists;

	async findMany<F extends string>({
		fields,
		where,
		orderBy,
		limit,
		offset,
		tx,
	}: ProjectedSelectParams<F>): Promise<Array<SelectFields<UserRating, F>>> {
		const data = await selectManyWithFields(userRatings, { where, orderBy, limit, offset, tx, fields });

		return data.map((item) => QueryFields.apply(item, fields));
	}

	async findFirst<F extends string>({
		where,
		fields,
		tx,
	}: {
		where?: SQL | undefined;
		fields?: FieldsConfig<F> | undefined;
		tx?: DatabaseTransaction | undefined;
	}): Promise<SelectFields<UserRating, F> | undefined> {
		const data = await selectFirstWithFields(userRatings, { where, tx, fields });

		if (!data) return undefined;

		return QueryFields.apply(data, fields);
	}

	/** The profile's rating for a metadata row, if any. */
	async findByProfileAndMetadata(profileId: string, metadataId: string) {
		return await this.selectFirst({ where: and(eq(this.table.profileId, profileId), eq(this.table.metadataId, metadataId)) });
	}

	async upsert({ profileId, metadataId, rating, tx }: { profileId: string; metadataId: string; rating: number; tx?: DatabaseTransaction }) {
		const [result] = await databaseFactory
			.getClient({ tx })
			.insert(this.table)
			.values({ profileId, metadataId, rating })
			.onConflictDoUpdate({
				target: [this.table.profileId, this.table.metadataId],
				set: { rating, updatedAt: new Date() },
			})
			.returning();

		return result;
	}

	async findPage<F extends string>(
		query?: PaginationQuery & FieldsQuery<F> & UserRatingFilters & UserRatingSorting,
	): Promise<PaginatedResponse<SelectFields<UserRating, F>>> {
		return await findPageWithQueryMap(userRatings, userRatingQueryMap, query);
	}

	async upsertInTransaction(input: { profileId: string; metadataId: string; rating: number }) {
		return await this.upsert(input);
	}

	async deleteForProfileMetadata({ profileId, metadataId, tx }: { profileId: string; metadataId: string; tx?: DatabaseTransaction }) {
		await this.delete({
			where: and(eq(this.table.profileId, profileId), eq(this.table.metadataId, metadataId)),
			tx,
		});
	}
}

export const userRatingsRepository = new UserRatingsRepository();
