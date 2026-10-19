import type {
	CreateSubtitleRequest,
	PaginatedResponse,
	PaginationQuery,
	SelectFields,
	SubtitleEntity,
	SubtitleFilters,
	SubtitleSorting,
	SubtitleType,
	UpdateSubtitleRequest,
} from "@reelvault/sdk/common";
import { and, eq, isNull, or, type SQL, sql } from "drizzle-orm";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import type { DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import { QueryFiltering } from "@/integrations/drizzle-orm/query/parsing/filtering.parser";
import type { QueryMap } from "@/integrations/drizzle-orm/query/parsing/query.parser";
import { createPreparedQuery } from "@/integrations/drizzle-orm/query/prepared-queries.utils";
import { type FindFirstReadParams, type PrimaryIdReadParams, selectByPrimaryId } from "@/integrations/drizzle-orm/query/primary-id.reader";
import { selectFirstWithFields } from "@/integrations/drizzle-orm/query/table-access/field-projection.utils";
import { findPageWithQueryMap } from "@/integrations/drizzle-orm/query/table-access/reads.reader";
import { defineRepository, defineTableAccess } from "@/integrations/drizzle-orm/query/table-access/table-access.factory";

const subtitles = defineTableAccess("subtitles", {
	primaryKeyColumn: "id",
});

type SubtitlesReadClient = ReturnType<typeof databaseFactory.getClient>;

/** Fixed-shape per-file read: prepared once per connection instead of rebuilt per request. */
const preparedSubtitlesByMediaFile = createPreparedQuery((client: SubtitlesReadClient) =>
	client
		.select()
		.from(subtitles.table)
		.where(eq(subtitles.table.mediaFileId, sql.placeholder("mediaFileId")))
		.prepare(),
);

const subtitleQueryMap: QueryMap<SubtitleFilters, SubtitleSorting> = {
	filters: {
		// Text search: one term matched against the label, the language and the media file id.
		q: (value: string) =>
			or(
				QueryFiltering.like(schema.subtitles.label, value),
				QueryFiltering.like(schema.subtitles.language, value),
				QueryFiltering.like(schema.subtitles.mediaFileId, value),
			) ?? sql`1 = 0`,
		mediaFileId: (value: string) => QueryFiltering.eq(schema.subtitles.mediaFileId, value),
		language: (value: string) => QueryFiltering.like(schema.subtitles.language, value),
		label: (value: string) => QueryFiltering.like(schema.subtitles.label, value),
		format: (value: string) => QueryFiltering.like(schema.subtitles.format, value),
		type: (value: string) => QueryFiltering.like(schema.subtitles.type, value),
		streamIndex: (value: number) => QueryFiltering.eq(schema.subtitles.streamIndex, value),
		isDefault: (value: boolean) => QueryFiltering.eq(schema.subtitles.isDefault, value),
		isForced: (value: boolean) => QueryFiltering.eq(schema.subtitles.isForced, value),
	},
	orderBy: {
		language: schema.subtitles.language,
		label: schema.subtitles.label,
		format: schema.subtitles.format,
		type: schema.subtitles.type,
		streamIndex: schema.subtitles.streamIndex,
		isDefault: schema.subtitles.isDefault,
		isForced: schema.subtitles.isForced,
		createdAt: schema.subtitles.createdAt,
		updatedAt: schema.subtitles.updatedAt,
	},
	defaults: { sortBy: "createdAt", sortOrder: "asc" },
};

const overrides = {
	async findPage(query?: PaginationQuery & SubtitleFilters & SubtitleSorting): Promise<PaginatedResponse<SubtitleEntity>> {
		return await findPageWithQueryMap({
			access: subtitles,
			queryMap: subtitleQueryMap,
			query,
			findMany: (params) => subtitles.findMany(params),
		});
	},

	async findByMediaFileId(mediaFileId: string, tx?: DatabaseTransaction) {
		return await preparedSubtitlesByMediaFile(databaseFactory.getClient({ tx })).execute({ mediaFileId });
	},

	/** Ids of every subtitle row — the orphan FileUtils/worker sweep compares extracted VTT files against it. */
	async findAllIds(): Promise<Set<string>> {
		const rows = await databaseFactory.getClient().select({ id: schema.subtitles.id }).from(schema.subtitles);

		return new Set(rows.map((row) => row.id));
	},

	async createAndRead(body: CreateSubtitleRequest, type: SubtitleType) {
		const { sourcePath, ...values } = body;
		const subtitle = await databaseFactory.transaction(
			async (tx) =>
				await getSubtitlesRepository().findOrCreateForMediaFile({
					mediaFileId: body.mediaFileId,
					streamIndex: body.streamIndex,
					filePath: sourcePath,
					values: { ...values, type, filePath: sourcePath },
					tx,
				}),
		);

		return subtitle;
	},

	async updateAndRead(id: string, body: UpdateSubtitleRequest) {
		const { sourcePath, ...values } = body;
		const updateValues = sourcePath === undefined ? values : { ...values, filePath: sourcePath };

		return await subtitles.updateAndReturn({ primaryId: id, values: updateValues });
	},

	async deleteAndReturn(id: string) {
		return await subtitles.deleteAndReturn({ primaryId: id });
	},

	async findFirst<F extends string>(params: FindFirstReadParams<F>): Promise<SelectFields<SubtitleEntity, F> | undefined> {
		return await selectFirstWithFields(subtitles, params);
	},

	async findByPrimaryId<F extends string>(params: PrimaryIdReadParams<F>): Promise<SelectFields<SubtitleEntity, F> | undefined> {
		return await selectByPrimaryId(subtitles, (readParams) => getSubtitlesRepository().findFirst(readParams), params);
	},

	async findOrCreateForMediaFile({
		mediaFileId,
		streamIndex,
		filePath,
		values,
		tx,
	}: {
		mediaFileId: string;
		streamIndex?: number | undefined;
		filePath?: string | undefined;
		values: typeof schema.subtitles.$inferInsert;
		tx?: DatabaseTransaction | undefined;
	}) {
		let sourceCondition: SQL | undefined;
		if (streamIndex !== undefined) {
			sourceCondition = eq(subtitles.table.streamIndex, streamIndex);
		} else if (filePath !== undefined) {
			sourceCondition = eq(subtitles.table.filePath, filePath);
		} else {
			sourceCondition = isNull(subtitles.table.filePath);
		}

		return await getSubtitlesRepository()
			.findOrCreate({
				where: and(eq(subtitles.table.mediaFileId, mediaFileId), sourceCondition),
				values,
				tx,
			})
			.then(async (subtitle) => {
				if (subtitle || values.type === "embedded") return subtitle;

				// External rows are uniquely keyed by (mediaFileId, language, type); a
				// second file for the same language loses the insert and the source-based
				// fallback above misses. Re-read by the real identity.
				return await getSubtitlesRepository().findFirst({
					where: and(
						eq(subtitles.table.mediaFileId, mediaFileId),
						eq(subtitles.table.language, values.language),
						eq(subtitles.table.type, "external"),
					),
					tx,
				});
			});
	},

	async findExternalByMediaFileAndLanguage({
		mediaFileId,
		language,
		tx,
	}: {
		mediaFileId: string;
		language: string;
		tx?: DatabaseTransaction | undefined;
	}) {
		return await getSubtitlesRepository().findFirst({
			where: and(
				eq(subtitles.table.mediaFileId, mediaFileId),
				eq(subtitles.table.language, language),
				eq(subtitles.table.type, "external"),
			),
			tx,
		});
	},

	/** Existing external-subtitle languages of one media file (batch probe for sidecar imports). */
	async findExternalLanguagesByMediaFile(mediaFileId: string, tx?: DatabaseTransaction): Promise<Set<string>> {
		const rows = await getSubtitlesRepository().selectMany({
			where: and(eq(subtitles.table.mediaFileId, mediaFileId), eq(subtitles.table.type, "external")),
			tx,
		});

		return new Set(rows.map((row) => row.language));
	},
};

export const subtitlesRepository = defineRepository(subtitles, overrides);

/** Methods dispatch through the singleton: the lint rule forbids referencing the const before its definition. */
function getSubtitlesRepository() {
	return subtitlesRepository;
}
