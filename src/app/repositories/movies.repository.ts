import type { FieldsQuery, MovieFilters, MovieSorting, MovieWithRelations, PaginationQuery, SelectFields } from "@reelvault/sdk/common";
import { eq, ne, sql } from "drizzle-orm";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import type { DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import { QueryFields } from "@/integrations/drizzle-orm/query/parsing/fields.parser";
import { QueryFiltering } from "@/integrations/drizzle-orm/query/parsing/filtering.parser";
import type { QueryMap } from "@/integrations/drizzle-orm/query/parsing/query.parser";
import { selectManyWithFields } from "@/integrations/drizzle-orm/query/table-access/field-projection.utils";
import { findPageWithQueryMap } from "@/integrations/drizzle-orm/query/table-access/reads.reader";
import { defineTableAccess } from "@/integrations/drizzle-orm/query/table-access/table-access.factory";
import type { ProjectedSelectParams } from "@/integrations/drizzle-orm/query/table-access/table-access.types";
import { findOrCreateWithIdentityRecovery } from "@/integrations/drizzle-orm/query/upsert-by-identity.writer";
import { findManyWithMediaFiles } from "@/integrations/drizzle-orm/utils/media-file-projection.builder";
import { createLocalStableKey } from "@/integrations/drizzle-orm/utils/stable-key.utils";

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
		return await findPageWithQueryMap({
			access: movies,
			queryMap: movieQueryMap,
			query,
			findMany: (params) => this.findMany(params),
		});
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
		const data = await selectManyWithFields(movies, { fields, required: ["id"], where, orderBy, limit, offset, tx });
		const rows = await findManyWithMediaFiles(data, { fields, relation: "movieId", tx });

		return rows.map((item) => QueryFields.apply<MovieWithRelations, F>(item, fields));
	}
}

export const moviesRepository = new MoviesRepository();
