import type { FieldsConfig, FieldsQuery, SelectFields } from "@sdk/common/fields";
import type { PaginatedResponse, PaginationQuery } from "@sdk/common/pagination";
import type { Season, SeasonFilters, SeasonSorting } from "@sdk/common/season.types";
import { and, eq, ne, or, type SQL, sql } from "drizzle-orm";
import { databaseFactory } from "@/database/database";
import { schema } from "@/database/schema";
import type { ProjectedSelectParams } from "@/database/table-access";
import { defineTableAccess, findPageWithQueryMap, selectFirstWithFields, selectManyWithFields } from "@/database/table-access";
import type { DatabaseTransaction } from "@/database/types";
import { QueryFields } from "@/database/utils/fields";
import { QueryFiltering } from "@/database/utils/filtering";
import { type QueryMap, QueryUtils } from "@/database/utils/query-parser";
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

class SeasonsRepository {
	readonly table = schema.seasons;
	readonly primaryKeyColumn = seasons.primaryKeyColumn;
	readonly query = seasons.query;
	readonly selectMany = seasons.selectMany;
	readonly selectFirst = seasons.selectFirst;
	readonly findOrCreate = seasons.findOrCreate;
	readonly insert = seasons.insert;
	readonly update = seasons.update;
	readonly delete = seasons.delete;
	readonly count = seasons.count;
	readonly isExists = seasons.isExists;
	readonly insertReturning = seasons.insertReturning;
	readonly updateReturning = seasons.updateReturning;
	readonly updateAndReturn = seasons.updateAndReturn;
	readonly deleteReturning = seasons.deleteReturning;
	readonly deleteAndReturn = seasons.deleteAndReturn;
	readonly findByIds = seasons.findByIds;
	readonly findByColumnIn = seasons.findByColumnIn;

	async findPage<F extends string>(
		query?: PaginationQuery & FieldsQuery<F> & SeasonFilters & SeasonSorting,
	): Promise<PaginatedResponse<SelectFields<Season, F>>> {
		return await findPageWithQueryMap(seasons, seasonQueryMap, query);
	}

	async findByIdForRead<F extends string>(seasonId: string, query?: FieldsQuery<F>) {
		const { fields } = QueryUtils.parseStandard(query);

		return await this.findByPrimaryId({ primaryId: seasonId, fields });
	}

	/** All seasons for a metadata row (raw rows, no relations). */
	async findByMetadataId(metadataId: string) {
		return await this.selectMany({ where: eq(this.table.metadataId, metadataId) });
	}

	/** A season by its metadata row and number. */
	async findByMetadataAndNumber(metadataId: string, seasonNumber: number) {
		return await this.findFirst({ where: and(eq(this.table.metadataId, metadataId), eq(this.table.seasonNumber, seasonNumber)) });
	}

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
					.insert(this.table)
					.values({ ...values, stableKey })
					.onConflictDoUpdate({
						target: this.table.stableKey,
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
							or(ne(this.table.metadataId, sql`excluded.metadata_id`), ne(this.table.seasonNumber, sql`excluded.season_number`)) ??
							sql`1 = 1`,
					})
					.returning();

				return season;
			},
			findByStableKey: async () => await this.selectFirst({ where: eq(this.table.stableKey, stableKey), tx }),
			findByIdentity: async () =>
				await this.selectFirst({ where: and(eq(this.table.metadataId, metadataId), eq(this.table.seasonNumber, seasonNumber)), tx }),
			reconcile: async (existing) => {
				const [updated] = await databaseFactory
					.getClient({ tx })
					.update(this.table)
					.set({ ...values, stableKey, updatedAt: new Date() })
					.where(eq(this.table.id, existing.id))
					.returning();

				return updated ?? existing;
			},
		});
	}

	async findMany<F extends string>({
		where,
		orderBy,
		fields,
		limit,
		offset,
		tx,
	}: ProjectedSelectParams<F>): Promise<Array<SelectFields<Season, F>>> {
		const data = await selectManyWithFields(seasons, { where, orderBy, limit, offset, tx, fields });

		return data.map((item) => QueryFields.apply(item, fields));
	}

	async findByPrimaryId<F extends string>({
		primaryId,
		fields,
		tx,
	}: {
		primaryId: string;
		fields?: FieldsConfig<F> | undefined;
		tx?: DatabaseTransaction | undefined;
	}): Promise<SelectFields<Season, F> | undefined> {
		return await this.findFirst({ where: eq(this.primaryKeyColumn, primaryId), fields, tx });
	}

	async findFirst<F extends string>({
		where,
		fields,
		tx,
	}: {
		where?: SQL | undefined;
		fields?: FieldsConfig<F> | undefined;
		tx?: DatabaseTransaction | undefined;
	}): Promise<SelectFields<Season, F> | undefined> {
		const data = await selectFirstWithFields(seasons, { where, tx, fields });

		if (!data) return undefined;

		return QueryFields.apply(data, fields);
	}
}

export const seasonsRepository = new SeasonsRepository();
