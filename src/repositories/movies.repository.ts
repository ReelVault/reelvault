import type { FieldsQuery, MovieFilters, MovieSorting, MovieWithRelations, PaginationQuery, SelectFields } from "@reelvault/sdk/common";
import { eq, ne, sql } from "drizzle-orm";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import type { DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import { applyFields } from "@/integrations/drizzle-orm/query/parsing/fields.parser";
import { filterEquals } from "@/integrations/drizzle-orm/query/parsing/filtering.parser";
import type { QueryMap } from "@/integrations/drizzle-orm/query/parsing/query.parser";
import { selectManyWithFields } from "@/integrations/drizzle-orm/query/table-access/field-projection.utils";
import { findPageWithQueryMap } from "@/integrations/drizzle-orm/query/table-access/reads.reader";
import { defineRepository, defineTableAccess } from "@/integrations/drizzle-orm/query/table-access/table-access.factory";
import type { ProjectedSelectParams } from "@/integrations/drizzle-orm/query/table-access/table-access.types";
import { upsertByStableKeyIdentity } from "@/integrations/drizzle-orm/query/upsert-by-identity.writer";
import { findManyWithMediaFiles } from "@/integrations/drizzle-orm/utils/media-file-projection.builder";
import { createLocalStableKey } from "@/integrations/drizzle-orm/utils/stable-key.utils";

const movies = defineTableAccess("movies", {
	primaryKeyColumn: "id",
});

const movieQueryMap: QueryMap<MovieFilters, MovieSorting> = {
	filters: { metadataId: (value: string) => filterEquals(schema.movies.metadataId, value) },
	orderBy: { createdAt: schema.movies.createdAt, updatedAt: schema.movies.updatedAt },
	defaults: { sortBy: "createdAt", sortOrder: "desc" },
};

const overrides = {
	async findPage<F extends string>(query?: PaginationQuery & FieldsQuery<F> & MovieFilters & MovieSorting) {
		return await findPageWithQueryMap({
			access: movies,
			queryMap: movieQueryMap,
			query,
			findMany: (params) => getMoviesRepository().findMany(params),
		});
	},

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

		return await upsertByStableKeyIdentity(movies, {
			stableKey,
			values: { metadataId, stableKey },
			identityWhere: eq(movies.table.metadataId, metadataId),
			set: { metadataId: sql`excluded.metadata_id` },
			setWhere: ne(movies.table.metadataId, sql`excluded.metadata_id`),
			reconcileValues: { stableKey },
			tx,
		});
	},

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

		return rows.map((item) => applyFields<MovieWithRelations, F>(item, fields));
	},
};

export const moviesRepository = defineRepository(movies, overrides);

/** Methods dispatch through the singleton: the lint rule forbids referencing the const before its definition. */
function getMoviesRepository() {
	return moviesRepository;
}
