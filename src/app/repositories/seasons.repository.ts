import type {
	FieldsQuery,
	PaginatedResponse,
	PaginationQuery,
	Season,
	SeasonFilters,
	SeasonSorting,
	SelectFields,
} from "@reelvault/sdk/common";
import { and, asc, eq, ne, or, sql } from "drizzle-orm";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import type { DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import { filterEquals, filterLike } from "@/integrations/drizzle-orm/query/parsing/filtering.parser";
import type { QueryMap } from "@/integrations/drizzle-orm/query/parsing/query.parser";
import { type FindFirstReadParams, type PrimaryIdReadParams, selectByPrimaryId } from "@/integrations/drizzle-orm/query/primary-id.reader";
import { selectFirstWithFields } from "@/integrations/drizzle-orm/query/table-access/field-projection.utils";
import { findPageWithQueryMap } from "@/integrations/drizzle-orm/query/table-access/reads.reader";
import {
	defineRepository,
	defineTableAccess,
	parseFieldsForRead,
} from "@/integrations/drizzle-orm/query/table-access/table-access.factory";
import { upsertByStableKeyIdentity } from "@/integrations/drizzle-orm/query/upsert-by-identity.writer";
import { createLocalStableKey } from "@/integrations/drizzle-orm/utils/stable-key.utils";

const seasons = defineTableAccess("seasons", {
	primaryKeyColumn: "id",
});

const seasonQueryMap: QueryMap<SeasonFilters, SeasonSorting> = {
	filters: {
		metadataId: (value: string) => filterEquals(schema.seasons.metadataId, value),
		name: (value: string) => filterLike(schema.seasons.name, value),
		seasonNumber: (value: number) => filterEquals(schema.seasons.seasonNumber, value),
		airDate: (value: string) => filterLike(schema.seasons.airDate, value),
		status: (value: string) => filterLike(schema.seasons.status, value),
	},
	orderBy: {
		name: schema.seasons.name,
		seasonNumber: schema.seasons.seasonNumber,
		airDate: schema.seasons.airDate,
		status: schema.seasons.status,
		createdAt: schema.seasons.createdAt,
		updatedAt: schema.seasons.updatedAt,
	},
	defaults: { sortBy: "seasonNumber", sortOrder: "asc" },
};

const overrides = {
	async findPage<F extends string>(
		query?: PaginationQuery & FieldsQuery<F> & SeasonFilters & SeasonSorting,
	): Promise<PaginatedResponse<SelectFields<Season, F>>> {
		return await findPageWithQueryMap({
			access: seasons,
			queryMap: seasonQueryMap,
			query,
			findMany: (params) => seasons.findMany<F>(params),
		});
	},

	async findByIdForRead<F extends string>(seasonId: string, query?: FieldsQuery<F>) {
		return await getSeasonsRepository().findByPrimaryId({ primaryId: seasonId, fields: parseFieldsForRead(query) });
	},

	/** All seasons for a metadata row (raw rows, no relations), in season order. */
	async findByMetadataId(metadataId: string) {
		return await getSeasonsRepository().selectMany({
			where: eq(seasons.table.metadataId, metadataId),
			orderBy: asc(seasons.table.seasonNumber),
		});
	},

	/** A season by its metadata row and number. */
	async findByMetadataAndNumber(metadataId: string, seasonNumber: number) {
		return await getSeasonsRepository().findFirst({
			where: and(eq(seasons.table.metadataId, metadataId), eq(seasons.table.seasonNumber, seasonNumber)),
		});
	},

	async findOrCreateByIdentity({
		metadataId,
		seasonNumber,
		metadataStableKey,
		values,
		tx,
	}: {
		metadataId: string;
		seasonNumber: number;
		metadataStableKey?: string | null | undefined;
		values: Omit<typeof schema.seasons.$inferInsert, "stableKey"> & { stableKey?: string };
		tx?: DatabaseTransaction | undefined;
	}) {
		const stableKey = createLocalStableKey({
			namespace: "season",
			value: `${metadataStableKey ?? createLocalStableKey({ namespace: "metadata", value: metadataId })}:${seasonNumber}`,
		});

		return await upsertByStableKeyIdentity(seasons, {
			stableKey,
			values: { ...values, stableKey },
			identityWhere: and(eq(seasons.table.metadataId, metadataId), eq(seasons.table.seasonNumber, seasonNumber)),
			setWhere:
				or(ne(seasons.table.metadataId, sql`excluded.metadata_id`), ne(seasons.table.seasonNumber, sql`excluded.season_number`)) ??
				sql`1 = 1`,
			reconcileValues: { ...values, stableKey },
			tx,
		});
	},

	async findByPrimaryId<F extends string>(params: PrimaryIdReadParams<F>): Promise<SelectFields<Season, F> | undefined> {
		return await selectByPrimaryId(seasons, (readParams) => getSeasonsRepository().findFirst(readParams), params);
	},

	async findFirst<F extends string>(params: FindFirstReadParams<F>): Promise<SelectFields<Season, F> | undefined> {
		return await selectFirstWithFields(seasons, params);
	},

	/**
	 * Chunked CASE update for provider syncs: one statement per chunk assigns
	 * per-row values, and rows that omit a field keep their stored value. Replaces
	 * one autocommit UPDATE per changed season.
	 */
	async updateManyFields(
		updates: ReadonlyArray<{
			id: string;
			values: Partial<Pick<typeof schema.seasons.$inferInsert, "name" | "overview" | "airDate" | "status">>;
		}>,
	): Promise<void> {
		await seasons.updateManyFields({
			columns: {
				name: seasons.table.name,
				overview: seasons.table.overview,
				airDate: seasons.table.airDate,
				status: seasons.table.status,
			},
			updates,
			touchUpdatedAt: true,
		});
	},
};

export const seasonsRepository = defineRepository(seasons, overrides);

/** Methods dispatch through the singleton: the lint rule forbids referencing the const before its definition. */
function getSeasonsRepository() {
	return seasonsRepository;
}
