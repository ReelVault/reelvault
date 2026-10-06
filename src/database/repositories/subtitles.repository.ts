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
import { and, eq, isNull, type SQL } from "drizzle-orm";
import { databaseFactory } from "@/database/database";
import { schema } from "@/database/schema";
import { defineRepository, defineTableAccess, findPageWithQueryMap, selectFirstWithFields } from "@/database/table-access";
import type { DatabaseTransaction } from "@/database/types";
import { QueryFiltering } from "@/database/utils/filtering";
import { type FindFirstReadParams, type PrimaryIdReadParams, selectByPrimaryId } from "@/database/utils/primary-id-read";
import type { QueryMap } from "@/database/utils/query-parser";

const subtitles = defineTableAccess("subtitles", {
	primaryKeyColumn: "id",
});

const subtitleQueryMap: QueryMap<SubtitleFilters, SubtitleSorting> = {
	filters: {
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
		return await getSubtitlesRepository().selectMany({
			where: eq(subtitles.table.mediaFileId, mediaFileId),
			tx,
		});
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

		return await getSubtitlesRepository().findOrCreate({
			where: and(eq(subtitles.table.mediaFileId, mediaFileId), sourceCondition),
			values,
			tx,
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
};

export const subtitlesRepository = defineRepository(subtitles, overrides);

/** Methods dispatch through the singleton so tests can monkey-patch delegations. */
function getSubtitlesRepository() {
	return subtitlesRepository;
}
