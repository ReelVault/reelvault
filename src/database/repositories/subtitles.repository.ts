import type {
	CreateSubtitleRequest,
	FieldsConfig,
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
import type { ProjectedSelectParams } from "@/database/table-access";
import { defineTableAccess, findPageWithQueryMap } from "@/database/table-access";
import type { DatabaseTransaction } from "@/database/types";
import { QueryFields } from "@/database/utils/fields";
import { QueryFiltering } from "@/database/utils/filtering";
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

class SubtitlesRepository {
	readonly table = schema.subtitles;
	readonly primaryKeyColumn = subtitles.primaryKeyColumn;
	readonly query = subtitles.query;
	readonly selectMany = subtitles.selectMany;
	readonly selectFirst = subtitles.selectFirst;
	readonly findOrCreate = subtitles.findOrCreate;
	readonly insert = subtitles.insert;
	readonly update = subtitles.update;
	readonly delete = subtitles.delete;
	readonly count = subtitles.count;
	readonly isExists = subtitles.isExists;
	readonly insertReturning = subtitles.insertReturning;
	readonly updateReturning = subtitles.updateReturning;
	readonly updateAndReturn = subtitles.updateAndReturn;
	readonly deleteReturning = subtitles.deleteReturning;
	readonly findByIds = subtitles.findByIds;
	readonly findByColumnIn = subtitles.findByColumnIn;

	async findPage(query?: PaginationQuery & SubtitleFilters & SubtitleSorting): Promise<PaginatedResponse<SubtitleEntity>> {
		return await findPageWithQueryMap(subtitles, subtitleQueryMap, query);
	}

	async findByMediaFileId(mediaFileId: string, tx?: DatabaseTransaction) {
		return await this.selectMany({
			where: eq(this.table.mediaFileId, mediaFileId),
			tx,
		});
	}

	async createAndRead(body: CreateSubtitleRequest, type: SubtitleType) {
		const { sourcePath, ...values } = body;
		const subtitle = await databaseFactory.transaction(
			async (tx) =>
				await this.findOrCreateForMediaFile({
					mediaFileId: body.mediaFileId,
					streamIndex: body.streamIndex,
					filePath: sourcePath,
					values: { ...values, type, filePath: sourcePath },
					tx,
				}),
		);

		return subtitle ? await this.findByPrimaryId({ primaryId: subtitle.id }) : undefined;
	}

	async updateAndRead(id: string, body: UpdateSubtitleRequest) {
		const { sourcePath, ...values } = body;
		const updateValues = sourcePath === undefined ? values : { ...values, filePath: sourcePath };

		return await subtitles.updateAndReturn({ primaryId: id, values: updateValues });
	}

	async deleteAndReturn(id: string) {
		return await subtitles.deleteAndReturn({ primaryId: id });
	}

	async findMany<F extends string>({
		fields,
		where,
		orderBy,
		limit,
		offset,
		tx,
	}: ProjectedSelectParams<F>): Promise<Array<SelectFields<SubtitleEntity, F>>> {
		const data = await this.selectMany({ where, orderBy, limit, offset, tx });

		return data.map((item) => QueryFields.apply(item, fields));
	}

	async findFirst<F extends string>({
		where,
		fields,
		tx,
	}: {
		where?: SQL | undefined;
		fields?: FieldsConfig<F> | undefined;
		tx?: DatabaseTransaction | undefined;
	}): Promise<SelectFields<SubtitleEntity, F> | undefined> {
		const data = await this.selectFirst({ where, tx });

		if (!data) return undefined;

		return QueryFields.apply(data, fields);
	}

	async findByPrimaryId<F extends string>({
		primaryId,
		fields,
		tx,
	}: {
		primaryId: string;
		fields?: FieldsConfig<F> | undefined;
		tx?: DatabaseTransaction | undefined;
	}): Promise<SelectFields<SubtitleEntity, F> | undefined> {
		return await this.findFirst({ where: eq(this.primaryKeyColumn, primaryId), fields, tx });
	}

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
			sourceCondition = eq(this.table.streamIndex, streamIndex);
		} else if (filePath !== undefined) {
			sourceCondition = eq(this.table.filePath, filePath);
		} else {
			sourceCondition = isNull(this.table.filePath);
		}

		return await this.findOrCreate({ where: and(eq(this.table.mediaFileId, mediaFileId), sourceCondition), values, tx });
	}

	async findExternalByMediaFileAndLanguage({
		mediaFileId,
		language,
		tx,
	}: {
		mediaFileId: string;
		language: string;
		tx?: DatabaseTransaction | undefined;
	}) {
		return await this.findFirst({
			where: and(eq(this.table.mediaFileId, mediaFileId), eq(this.table.language, language), eq(this.table.type, "external")),
			tx,
		});
	}
}

export const subtitlesRepository = new SubtitlesRepository();
