import type {
	FieldsQuery,
	PaginatedResponse,
	PaginationQuery,
	Season,
	SeasonFilters,
	SeasonSorting,
	SelectFields,
} from "@reelvault/sdk/common";
import { and, eq, ne, or, sql } from "drizzle-orm";
import { databaseFactory } from "@/database/database";
import { schema } from "@/database/schema";
import {
	defineRepository,
	defineTableAccess,
	findPageWithQueryMap,
	parseFieldsForRead,
	selectFirstWithFields,
} from "@/database/table-access";
import type { DatabaseTransaction } from "@/database/types";
import { QueryFiltering } from "@/database/utils/filtering";
import { type FindFirstReadParams, type PrimaryIdReadParams, selectByPrimaryId } from "@/database/utils/primary-id-read";
import type { QueryMap } from "@/database/utils/query-parser";
import { createLocalStableKey } from "@/database/utils/stable-key";
import { findOrCreateWithIdentityRecovery } from "@/database/utils/upsert-by-identity";

const seasons = defineTableAccess("seasons", {
	primaryKeyColumn: "id",
});

const seasonQueryMap: QueryMap<SeasonFilters, SeasonSorting> = {
	filters: {
		metadataId: (value: string) => QueryFiltering.eq(schema.seasons.metadataId, value),
		name: (value: string) => QueryFiltering.like(schema.seasons.name, value),
		seasonNumber: (value: number) => QueryFiltering.eq(schema.seasons.seasonNumber, value),
		airDate: (value: string) => QueryFiltering.like(schema.seasons.airDate, value),
		status: (value: string) => QueryFiltering.like(schema.seasons.status, value),
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

	/** All seasons for a metadata row (raw rows, no relations). */
	async findByMetadataId(metadataId: string) {
		return await getSeasonsRepository().selectMany({ where: eq(seasons.table.metadataId, metadataId) });
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

		return await findOrCreateWithIdentityRecovery({
			stableKey,
			upsert: async () => {
				const [season] = await databaseFactory
					.getClient({ tx })
					.insert(seasons.table)
					.values({ ...values, stableKey })
					.onConflictDoUpdate({
						target: seasons.table.stableKey,
						set: {
							metadataId: sql`excluded.metadata_id`,
							imageId: sql`excluded.image_id`,
							seasonNumber: sql`excluded.season_number`,
							name: sql`excluded.name`,
							overview: sql`excluded.overview`,
							airDate: sql`excluded.air_date`,
							status: sql`excluded.status`,
							updatedAt: new Date(),
						},
						setWhere:
							or(ne(seasons.table.metadataId, sql`excluded.metadata_id`), ne(seasons.table.seasonNumber, sql`excluded.season_number`)) ??
							sql`1 = 1`,
					})
					.returning();

				return season;
			},
			findByStableKey: async () => await getSeasonsRepository().selectFirst({ where: eq(seasons.table.stableKey, stableKey), tx }),
			findByIdentity: async () =>
				await getSeasonsRepository().selectFirst({
					where: and(eq(seasons.table.metadataId, metadataId), eq(seasons.table.seasonNumber, seasonNumber)),
					tx,
				}),
			reconcile: async (existing) => {
				const [updated] = await databaseFactory
					.getClient({ tx })
					.update(seasons.table)
					.set({ ...values, stableKey, updatedAt: new Date() })
					.where(eq(seasons.table.id, existing.id))
					.returning();

				return updated ?? existing;
			},
		});
	},

	async findByPrimaryId<F extends string>(params: PrimaryIdReadParams<F>): Promise<SelectFields<Season, F> | undefined> {
		return await selectByPrimaryId(seasons, (readParams) => getSeasonsRepository().findFirst(readParams), params);
	},

	async findFirst<F extends string>(params: FindFirstReadParams<F>): Promise<SelectFields<Season, F> | undefined> {
		return await selectFirstWithFields(seasons, params);
	},
};

export const seasonsRepository = defineRepository(seasons, overrides);

/** Methods dispatch through the singleton so tests can monkey-patch delegations. */
function getSeasonsRepository() {
	return seasonsRepository;
}
