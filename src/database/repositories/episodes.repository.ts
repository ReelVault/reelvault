import type {
	EpisodeFilters,
	EpisodeSorting,
	EpisodeType,
	EpisodeWithRelations,
	FieldsConfig,
	FieldsQuery,
	PaginatedResponse,
	PaginationQuery,
	SelectFields,
} from "@reelvault/sdk/common";
import { and, eq, inArray, or, type SQL, sql } from "drizzle-orm";
import { databaseFactory } from "@/database/database";
import { schema } from "@/database/schema";
import type { ProjectedSelectParams } from "@/database/table-access";
import { defineTableAccess, findPageWithQueryMap } from "@/database/table-access";
import type { DatabaseTransaction } from "@/database/types";
import { QueryFields } from "@/database/utils/fields";
import { QueryFiltering } from "@/database/utils/filtering";
import { attachMediaFiles } from "@/database/utils/media-file-projection";
import { type QueryMap, QueryUtils } from "@/database/utils/query-parser";
import { createLocalStableKey } from "@/database/utils/stable-key";
import { findOrCreateWithIdentityRecovery } from "@/database/utils/upsert-by-identity";

const episodes = defineTableAccess("episodes", {
	primaryKeyColumn: "id",
});

const episodeQueryMap: QueryMap<EpisodeFilters, EpisodeSorting> = {
	filters: {
		seasonId: (value: string) => QueryFiltering.eq(schema.episodes.seasonId, value),
		metadataId: (value: string) =>
			inArray(
				schema.episodes.seasonId,
				databaseFactory.getClient().select({ id: schema.seasons.id }).from(schema.seasons).where(eq(schema.seasons.metadataId, value)),
			),
		episodeNumber: (value: number) => QueryFiltering.eq(schema.episodes.episodeNumber, value),
		title: (value: string) => QueryFiltering.like(schema.episodes.title, value),
		airDate: (value: string) => QueryFiltering.eq(schema.episodes.airDate, value),
		type: (value: EpisodeType) => QueryFiltering.eq(schema.episodes.episodeType, value),
	},
	orderBy: {
		title: schema.episodes.title,
		episodeNumber: schema.episodes.episodeNumber,
		airDate: schema.episodes.airDate,
		createdAt: schema.episodes.createdAt,
		updatedAt: schema.episodes.updatedAt,
	},
	defaults: { sortBy: "createdAt", sortOrder: "asc" },
};

class EpisodesRepository {
	readonly table = schema.episodes;
	readonly primaryKeyColumn = episodes.primaryKeyColumn;
	readonly query = episodes.query;
	readonly selectMany = episodes.selectMany;
	readonly selectFirst = episodes.selectFirst;
	readonly findOrCreate = episodes.findOrCreate;
	readonly insert = episodes.insert;
	readonly update = episodes.update;
	readonly delete = episodes.delete;
	readonly count = episodes.count;
	readonly isExists = episodes.isExists;
	readonly insertReturning = episodes.insertReturning;
	readonly updateReturning = episodes.updateReturning;
	readonly updateAndReturn = episodes.updateAndReturn;
	readonly deleteReturning = episodes.deleteReturning;
	readonly deleteAndReturn = episodes.deleteAndReturn;
	readonly findByIds = episodes.findByIds;
	readonly findByColumnIn = episodes.findByColumnIn;

	async findPage<F extends string>(
		query?: PaginationQuery & FieldsQuery<F> & EpisodeFilters & EpisodeSorting,
	): Promise<PaginatedResponse<SelectFields<EpisodeWithRelations, F>>> {
		return await findPageWithQueryMap(episodes, episodeQueryMap, query, (params) => this.findMany(params));
	}

	async findByIdForRead<F extends string>(episodeId: string, query?: FieldsQuery<F>) {
		const { fields } = QueryUtils.parseStandard(query);

		return await this.findByPrimaryId({ primaryId: episodeId, fields });
	}

	/** All episodes belonging to any of the given seasons (raw rows). */
	async findBySeasonIds(seasonIds: readonly string[]) {
		return await episodes.findByColumnIn(this.table.seasonId, seasonIds);
	}

	/** An episode by its season and number. */
	async findBySeasonAndNumber(seasonId: string, episodeNumber: number) {
		return await this.findFirst({ where: and(eq(this.table.seasonId, seasonId), eq(this.table.episodeNumber, episodeNumber)) });
	}

	/** Episodes of all seasons of a show projected for the metadata details view. */
	async findByMetadataIdProjected(metadataId: string) {
		const client = databaseFactory.getClient();

		return await client
			.select({
				id: this.table.id,
				stableKey: this.table.stableKey,
				seasonId: this.table.seasonId,
				imageId: this.table.imageId,
				episodeType: this.table.episodeType,
				episodeNumber: this.table.episodeNumber,
				absoluteNumber: this.table.absoluteNumber,
				title: this.table.title,
				overview: this.table.overview,
				airDate: this.table.airDate,
				createdAt: this.table.createdAt,
				updatedAt: this.table.updatedAt,
			})
			.from(this.table)
			.innerJoin(schema.seasons, eq(schema.seasons.id, this.table.seasonId))
			.where(eq(schema.seasons.metadataId, metadataId));
	}

	async findOrCreateByIdentity({
		seasonId,
		episodeNumber,
		seasonStableKey,
		values,
		tx,
	}: {
		seasonId: string;
		episodeNumber: number;
		seasonStableKey?: string | null | undefined;
		values: Omit<typeof schema.episodes.$inferInsert, "stableKey"> & { stableKey?: string };
		tx?: DatabaseTransaction | undefined;
	}) {
		const episodeType = values.episodeType ?? "regular";
		const stableKey = createLocalStableKey({
			namespace: "episode",
			value: `${seasonStableKey ?? createLocalStableKey({ namespace: "season", value: seasonId })}:${episodeType}:${episodeNumber}`,
		});

		return await findOrCreateWithIdentityRecovery({
			stableKey,
			upsert: async () => {
				const [episode] = await databaseFactory
					.getClient({ tx })
					.insert(this.table)
					.values({ ...values, episodeType, stableKey })
					.onConflictDoUpdate({
						target: this.table.stableKey,
						set: {
							seasonId: sql`excluded.season_id`,
							imageId: sql`excluded.image_id`,
							episodeType: sql`excluded.type`,
							episodeNumber: sql`excluded.episode_number`,
							title: sql`excluded.title`,
							overview: sql`excluded.overview`,
							airDate: sql`excluded.air_date`,
							updatedAt: new Date(),
						},
						setWhere:
							or(
								sql`${this.table.seasonId} <> excluded.season_id`,
								sql`${this.table.episodeType} <> excluded.type`,
								sql`${this.table.episodeNumber} <> excluded.episode_number`,
							) ?? sql`1 = 1`,
					})
					.returning();

				return episode;
			},
			findByStableKey: async () => await this.selectFirst({ where: eq(this.table.stableKey, stableKey), tx }),
			findByIdentity: async () =>
				await this.selectFirst({
					where: and(
						eq(this.table.seasonId, seasonId),
						eq(this.table.episodeType, episodeType),
						eq(this.table.episodeNumber, episodeNumber),
					),
					tx,
				}),
			reconcile: async (existing) => {
				const [updated] = await databaseFactory
					.getClient({ tx })
					.update(this.table)
					.set({ ...values, episodeType, stableKey, updatedAt: new Date() })
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
	}: ProjectedSelectParams<F>): Promise<Array<SelectFields<EpisodeWithRelations, F>>> {
		const data = await this.selectMany({ where, orderBy, limit, offset, tx });
		if (!QueryFields.includes(fields, "mediaFiles")) {
			return data.map((item) => QueryFields.apply({ ...item, mediaFiles: [] }, fields));
		}

		if (data.length === 0) return [];

		const rows = await attachMediaFiles(data, { fields, relation: "episodeId", tx });

		return rows.map((item) => QueryFields.apply<EpisodeWithRelations, F>(item, fields));
	}

	async findFirst<F extends string>({
		where,
		fields,
		tx,
	}: {
		where?: SQL | undefined;
		fields?: FieldsConfig<F> | undefined;
		tx?: DatabaseTransaction | undefined;
	}): Promise<SelectFields<EpisodeWithRelations, F> | undefined> {
		const data = await this.selectFirst({ where, tx });

		if (!data) return undefined;

		if (!QueryFields.includes(fields, "mediaFiles")) {
			return QueryFields.apply({ ...data, mediaFiles: [] }, fields);
		}

		const [row] = await attachMediaFiles([data], { fields, relation: "episodeId", tx });
		if (!row) return undefined;

		return QueryFields.apply<EpisodeWithRelations, F>(row, fields);
	}

	async findByPrimaryId<F extends string>({
		primaryId,
		fields,
		tx,
	}: {
		primaryId: string;
		fields?: FieldsConfig<F> | undefined;
		tx?: DatabaseTransaction | undefined;
	}): Promise<SelectFields<EpisodeWithRelations, F> | undefined> {
		return await this.findFirst({ where: eq(this.primaryKeyColumn, primaryId), fields, tx });
	}
}

export const episodesRepository = new EpisodesRepository();
