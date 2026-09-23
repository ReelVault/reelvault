import type { FieldsConfig } from "@sdk/common/fields";
import { inArray } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { databaseFactory } from "@/database/database";
import { schema } from "@/database/schema";
import { mapChunked } from "@/database/table-access";
import type { DatabaseTransaction } from "@/database/types";
import { serverConfig } from "@/server.config";
import { groupBy } from "@/utils/array.utils";

const mediaFileColumns = {
	id: schema.mediaFiles.id,
	libraryId: schema.mediaFiles.libraryId,
	metadataId: schema.mediaFiles.metadataId,
	movieId: schema.mediaFiles.movieId,
	episodeId: schema.mediaFiles.episodeId,
	filePath: schema.mediaFiles.filePath,
	fileName: schema.mediaFiles.fileName,
	formatName: schema.mediaFiles.formatName,
	duration: schema.mediaFiles.duration,
	size: schema.mediaFiles.size,
	bitRate: schema.mediaFiles.bitRate,
	source: schema.mediaFiles.source,
	edition: schema.mediaFiles.edition,
	qualityTag: schema.mediaFiles.qualityTag,
	isDefault: schema.mediaFiles.isDefault,
	isEnabled: schema.mediaFiles.isEnabled,
	sourceMtimeMs: schema.mediaFiles.sourceMtimeMs,
	createdAt: schema.mediaFiles.createdAt,
	updatedAt: schema.mediaFiles.updatedAt,
} as const;

type MediaFileRelation = "libraryId" | "movieId" | "episodeId";

export function buildRelationProjection<T extends Record<string, SQLiteColumn>>(
	relationFields: string[] | undefined,
	columns: T,
	required: readonly string[],
): T;

export function buildRelationProjection(
	relationFields: string[] | undefined,
	columns: Record<string, SQLiteColumn>,
	required: readonly string[],
): Record<string, SQLiteColumn> {
	const projection: Record<string, SQLiteColumn> = {};
	const requiredFields = new Set(required);
	const relationSet = relationFields ? new Set(relationFields) : undefined;
	for (const [name, column] of Object.entries(columns)) {
		if (requiredFields.has(name) || relationSet?.has(name)) {
			projection[name] = column;
		}
	}

	return projection;
}

export function buildMediaFileProjection(relationFields: string[] | undefined, relation: MediaFileRelation): typeof mediaFileColumns {
	return buildRelationProjection(relationFields, mediaFileColumns, ["id", relation]);
}

/**
 * Loads and attaches the `mediaFiles` relation for rows of one parent table
 * (movies by `movieId`, episodes by `episodeId`). Shared by the catalog
 * repositories' findMany/findFirst so the projection + groupBy dance lives here.
 */
export async function attachMediaFiles<F extends string, TRow extends { id: string }>(
	rows: TRow[],
	options: {
		fields?: FieldsConfig<F> | undefined;
		/** Parent FK column on `media_files` (`movieId` / `episodeId`). */
		relation: MediaFileRelation;
		tx?: DatabaseTransaction | undefined;
	},
): Promise<Array<TRow & { mediaFiles: Array<typeof schema.mediaFiles.$inferSelect> }>> {
	if (rows.length === 0) return [];

	// Chunk on chunk boundaries to keep the parent-id `inArray` bounded; each
	// row's media files are attached independently, so concatenation preserves order.
	if (rows.length > serverConfig.database.queryChunkSize) {
		return await mapChunked(rows, (rowChunk) => attachMediaFiles(rowChunk, options));
	}

	const client = databaseFactory.getClient({ tx: options.tx });
	const projection = options.fields?.relations.mediaFiles?.length
		? buildMediaFileProjection(options.fields.relations.mediaFiles, options.relation)
		: undefined;
	const mediaFiles = await (projection
		? client
				.select(projection)
				.from(schema.mediaFiles)
				.where(
					inArray(
						schema.mediaFiles[options.relation],
						rows.map((row) => row.id),
					),
				)
		: client
				.select()
				.from(schema.mediaFiles)
				.where(
					inArray(
						schema.mediaFiles[options.relation],
						rows.map((row) => row.id),
					),
				));
	const mediaFilesByParentId = groupBy(mediaFiles, (mediaFile) => mediaFile[options.relation]);

	return rows.map((row) => ({ ...row, mediaFiles: mediaFilesByParentId.get(row.id) ?? [] }));
}
