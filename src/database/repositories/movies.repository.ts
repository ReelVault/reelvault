import type { FieldsQuery, MovieFilters, MovieSorting, MovieWithRelations, PaginationQuery, SelectFields } from "@reelvault/sdk/common";
import { eq, ne, sql } from "drizzle-orm";
import { databaseFactory } from "@/database/database";
import { schema } from "@/database/schema";
import type { ProjectedSelectParams } from "@/database/table-access";
import { defineTableAccess, findPageWithQueryMap } from "@/database/table-access";
import type { DatabaseTransaction } from "@/database/types";
import { QueryFields } from "@/database/utils/fields";
import { QueryFiltering } from "@/database/utils/filtering";
import { attachMediaFiles } from "@/database/utils/media-file-projection";
import type { QueryMap } from "@/database/utils/query-parser";
import { createLocalStableKey } from "@/database/utils/stable-key";
import { findOrCreateWithIdentityRecovery } from "@/database/utils/upsert-by-identity";

const movies = defineTableAccess("movies", {
	primaryKeyColumn: "id",
});

const movieQueryMap: QueryMap<MovieFilters, MovieSorting> = {
	filters: { metadataId: (value: string) => QueryFiltering.eq(schema.movies.metadataId, value) },
	orderBy: { createdAt: schema.movies.createdAt, updatedAt: schema.movies.updatedAt },
	defaults: { sortBy: "createdAt", sortOrder: "desc" },
};

class MoviesRepository {
	readonly table = schema.movies;
	readonly primaryKeyColumn = movies.primaryKeyColumn;
	readonly query = movies.query;
	readonly selectMany = movies.selectMany;
	readonly selectFirst = movies.selectFirst;
	readonly findOrCreate = movies.findOrCreate;
	readonly insert = movies.insert;
	readonly update = movies.update;
	readonly delete = movies.delete;
	readonly insertReturning = movies.insertReturning;
	readonly updateReturning = movies.updateReturning;
	readonly updateAndReturn = movies.updateAndReturn;
	readonly deleteReturning = movies.deleteReturning;
	readonly deleteAndReturn = movies.deleteAndReturn;
	readonly findByIds = movies.findByIds;
	readonly findByColumnIn = movies.findByColumnIn;
	readonly count = movies.count;
	readonly isExists = movies.isExists;

	async findPage<F extends string>(query?: PaginationQuery & FieldsQuery<F> & MovieFilters & MovieSorting) {
		return await findPageWithQueryMap(movies, movieQueryMap, query, (params) => this.findMany(params));
	}

	async findOrCreateByMetadataId({
		metadataId,
		metadataStableKey,
		tx,
	}: {
		metadataId: string;
		metadataStableKey?: string | null | undefined;
		tx?: DatabaseTransaction | undefined;
	}) {
		const stableKey = createLocalStableKey({
			namespace: "movie",
			value: metadataStableKey ?? createLocalStableKey({ namespace: "metadata", value: metadataId }),
		});

		return await findOrCreateWithIdentityRecovery({
			stableKey,
			upsert: async () => {
				const [movie] = await databaseFactory
					.getClient({ tx })
					.insert(this.table)
					.values({ metadataId, stableKey })
					.onConflictDoUpdate({
						target: this.table.stableKey,
						set: { metadataId: sql`excluded.metadata_id`, updatedAt: new Date() },
						setWhere: ne(this.table.metadataId, sql`excluded.metadata_id`),
					})
					.returning();

				return movie;
			},
			findByStableKey: async () => await this.selectFirst({ where: eq(this.table.stableKey, stableKey), tx }),
			findByIdentity: async () => await this.selectFirst({ where: eq(this.table.metadataId, metadataId), tx }),
			reconcile: async (existing) => {
				const [updated] = await databaseFactory
					.getClient({ tx })
					.update(this.table)
					.set({ stableKey, updatedAt: new Date() })
					.where(eq(this.table.id, existing.id))
					.returning();

				return updated ?? existing;
			},
		});
	}

	async findMany<F extends string>({
		fields,
		where,
		orderBy,
		limit,
		offset,
		tx,
	}: ProjectedSelectParams<F>): Promise<Array<SelectFields<MovieWithRelations, F>>> {
		const data = await this.selectMany({ where, orderBy, limit, offset, tx });
		if (!QueryFields.includes(fields, "mediaFiles")) {
			return data.map((item) => QueryFields.apply({ ...item, mediaFiles: [] }, fields));
		}

		const rows = await attachMediaFiles(data, { fields, relation: "movieId", tx });

		return rows.map((item) => QueryFields.apply<MovieWithRelations, F>(item, fields));
	}
}

export const moviesRepository = new MoviesRepository();
