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
import { createPreparedQuery } from "@/database/prepared-queries";
import { schema } from "@/database/schema";
import type { ProjectedSelectParams } from "@/database/table-access";
import {
	defineTableAccess,
	findPageWithQueryMap,
	forEachChunked,
	mapChunked,
	parseFieldsForRead,
	selectManyWithFields,
} from "@/database/table-access";
import type { DatabaseTransaction } from "@/database/types";
import { QueryFields } from "@/database/utils/fields";
import { QueryFiltering } from "@/database/utils/filtering";
import { findFirstWithMediaFiles, findManyWithMediaFiles } from "@/database/utils/media-file-projection";
import type { QueryMap } from "@/database/utils/query-parser";
import { createLocalStableKey } from "@/database/utils/stable-key";
import { findOrCreateWithIdentityRecovery } from "@/database/utils/upsert-by-identity";
import { unique } from "@/utils/array.utils";

const episodes = defineTableAccess("episodes", {
	primaryKeyColumn: "id",
});

type EpisodesReadClient = ReturnType<typeof databaseFactory.getClient>;

/** Fixed-shape per-show reads: prepared once per connection instead of rebuilt per request. */
const preparedEpisodesProjectedByMetadata = createPreparedQuery((client: EpisodesReadClient) =>
	client
		.select({
			id: episodes.table.id,
			stableKey: episodes.table.stableKey,
			seasonId: episodes.table.seasonId,
			imageId: episodes.table.imageId,
			episodeType: episodes.table.episodeType,
			episodeNumber: episodes.table.episodeNumber,
			absoluteNumber: episodes.table.absoluteNumber,
			title: episodes.table.title,
			overview: episodes.table.overview,
			airDate: episodes.table.airDate,
			createdAt: episodes.table.createdAt,
			updatedAt: episodes.table.updatedAt,
		})
		.from(episodes.table)
		.innerJoin(schema.seasons, eq(schema.seasons.id, episodes.table.seasonId))
		.where(eq(schema.seasons.metadataId, sql.placeholder("metadataId")))
		// No id tie-break: it forces a temp B-tree sort; the season and episode index already yields this order.
		.orderBy(schema.seasons.seasonNumber, episodes.table.episodeNumber)
		.prepare(),
);

const preparedEpisodesWithFilesByMetadata = createPreparedQuery((client: EpisodesReadClient) =>
	client
		.select({
			id: episodes.table.id,
			seasonId: episodes.table.seasonId,
			seasonNumber: schema.seasons.seasonNumber,
			episodeNumber: episodes.table.episodeNumber,
			mediaFileId: schema.mediaFiles.id,
			mediaFileIsDefault: schema.mediaFiles.isDefault,
			mediaFileSize: schema.mediaFiles.size,
			mediaFileUpdatedAt: schema.mediaFiles.updatedAt,
		})
		.from(episodes.table)
		.innerJoin(schema.seasons, eq(schema.seasons.id, episodes.table.seasonId))
		.leftJoin(schema.mediaFiles, eq(schema.mediaFiles.episodeId, episodes.table.id))
		.where(eq(schema.seasons.metadataId, sql.placeholder("metadataId")))
		// No id tie-break: it forces a temp B-tree sort; the season and episode index already yields this order.
		.orderBy(schema.seasons.seasonNumber, episodes.table.episodeNumber)
		.prepare(),
);

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
	defaults: { sortBy: "episodeNumber", sortOrder: "asc" },
};

class EpisodesRepository {
	readonly table = schema.episodes;
	readonly primaryKeyColumn = episodes.primaryKeyColumn;
	readonly query = episodes.query;
	readonly selectMany = episodes.selectMany;
	readonly selectFirst = episodes.selectFirst;
	readonly selectFirstById = episodes.selectFirstById;
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
		return await findPageWithQueryMap({
			access: episodes,
			queryMap: episodeQueryMap,
			query,
			findMany: (params) => this.findMany(params),
		});
	}

	async findByIdForRead<F extends string>(episodeId: string, query?: FieldsQuery<F>) {
		return await this.findByPrimaryId({ primaryId: episodeId, fields: parseFieldsForRead(query) });
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
		return await preparedEpisodesProjectedByMetadata(databaseFactory.getClient()).execute({ metadataId });
	}

	/**
	 * Every episode of a show with its media files (LEFT JOIN keeps file-less
	 * episodes in the ordered list), ordered by season and episode number. Feeds
	 * the playback-view next-episode resolution with one query instead of a
	 * paginated service call per later season.
	 */
	async findEpisodesWithFilesByMetadataId(metadataId: string) {
		return await preparedEpisodesWithFilesByMetadata(databaseFactory.getClient()).execute({ metadataId });
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
		const data = await selectManyWithFields(episodes, { fields, required: ["id"], where, orderBy, limit, offset, tx });
		const rows = await findManyWithMediaFiles(data, { fields, relation: "episodeId", tx });

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

		const row = await findFirstWithMediaFiles(data, { fields, relation: "episodeId", tx });
		if (!row) return undefined;

		return QueryFields.apply<EpisodeWithRelations, F>(row, fields);
	}

	/**
	 * Batch variant of `findByPrimaryId` (media files attached, same projection
	 * semantics) for callers that resolve many episodes at once — e.g. the
	 * sidecar batch save. Chunked by the shared bound-variable limit.
	 */
	async findRecordsByIds<F extends string>(params: {
		ids: readonly string[];
		fields?: FieldsConfig<F> | undefined;
	}): Promise<Array<SelectFields<EpisodeWithRelations, F>>> {
		const ids = unique(params.ids.filter(Boolean));
		if (ids.length === 0) return [];

		return await mapChunked(ids, async (idChunk) => await this.findMany({ where: inArray(this.table.id, idChunk), fields: params.fields }));
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
		const data = await this.selectFirstById({ primaryId, tx });

		if (!data) return undefined;

		const row = await findFirstWithMediaFiles(data, { fields, relation: "episodeId", tx });
		if (!row) return undefined;

		return QueryFields.apply<EpisodeWithRelations, F>(row, fields);
	}

	/**
	 * Chunked CASE update for provider syncs: one statement per chunk assigns
	 * per-row values, and rows that omit a field keep their stored value. Replaces
	 * one autocommit UPDATE per changed episode.
	 */
	async updateManyFields(
		updates: ReadonlyArray<{
			id: string;
			values: Partial<Pick<typeof schema.episodes.$inferInsert, "title" | "overview" | "airDate" | "absoluteNumber">>;
		}>,
	): Promise<void> {
		const rows = updates.filter((update) => Object.keys(update.values).length > 0);
		if (rows.length === 0) return;

		const client = databaseFactory.getClient();
		await forEachChunked(rows, async (chunk) => {
			const set: { title?: SQL; overview?: SQL; airDate?: SQL; absoluteNumber?: SQL; updatedAt: Date } = { updatedAt: new Date() };
			for (const field of ["title", "overview", "airDate", "absoluteNumber"] as const) {
				const provided = chunk.filter((row) => row.values[field] !== undefined);
				if (provided.length === 0) continue;

				const cases = provided.map((row) => sql`WHEN ${row.id} THEN ${row.values[field]}`);
				set[field] = sql`CASE ${schema.episodes.id} ${sql.join(cases, sql` `)} ELSE ${schema.episodes[field]} END`;
			}

			await client
				.update(schema.episodes)
				.set(set)
				.where(
					inArray(
						schema.episodes.id,
						chunk.map((row) => row.id),
					),
				);
		});
	}
}

export const episodesRepository = new EpisodesRepository();
