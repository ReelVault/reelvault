import type { FieldsConfig } from "@reelvault/sdk/common";
import { inArray } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { databaseFactory } from "@/database/database";
import { schema } from "@/database/schema";
import { mapChunked, pickColumns } from "@/database/table-access";
import type { DatabaseTransaction } from "@/database/types";
import { QueryFields } from "@/database/utils/fields";
import { serverConstants } from "@/server.constants";
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
	// `new Set(undefined)` is empty: without relation fields only `required` is kept.
	return pickColumns(columns, new Set(relationFields), required);
}

export function buildMediaFileProjection(relationFields: string[] | undefined, relation: MediaFileRelation): typeof mediaFileColumns {
	return buildRelationProjection(relationFields, mediaFileColumns, ["id", relation]);
}

interface WithMediaFiles {
	mediaFiles: Array<typeof schema.mediaFiles.$inferSelect>;
}

interface MediaFileAttachmentOptions<F extends string> {
	fields?: FieldsConfig<F> | undefined;
	/** Parent FK column on `media_files` (`movieId` / `episodeId`). */
	relation: MediaFileRelation;
	tx?: DatabaseTransaction | undefined;
}

/**
 * Loads and attaches the `mediaFiles` relation for one bounded batch of parent
 * rows (movies by `movieId`, episodes by `episodeId`) — the single primitive
 * behind {@link findManyWithMediaFiles} and {@link findFirstWithMediaFiles}.
 */
async function attachMediaFiles<F extends string, TRow extends { id: string }>(
	rows: TRow[],
	options: MediaFileAttachmentOptions<F>,
): Promise<Array<TRow & WithMediaFiles>> {
	if (rows.length === 0) return [];

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

/**
 * Shared catalog read: attaches the `mediaFiles` relation to parent rows.
 * When `fields` excludes `mediaFiles` the relation is attached as an empty
 * array without querying (same contract as before). The caller applies its own
 * field projection — only the repository knows its DTO type.
 */
export async function findManyWithMediaFiles<F extends string, TRow extends { id: string }>(
	rows: TRow[],
	options: MediaFileAttachmentOptions<F>,
): Promise<Array<TRow & WithMediaFiles>> {
	if (!QueryFields.includes(options.fields, "mediaFiles")) {
		return rows.map((row) => ({ ...row, mediaFiles: [] }));
	}

	// Chunk on chunk boundaries to keep the parent-id `inArray` bounded; each
	// row's media files are attached independently, so concatenation preserves order.
	if (rows.length > serverConstants.database.queryChunkSize) {
		return await mapChunked(rows, (rowChunk) => attachMediaFiles(rowChunk, options));
	}

	return await attachMediaFiles(rows, options);
}

/** Single-row variant of {@link findManyWithMediaFiles}. */
export async function findFirstWithMediaFiles<F extends string, TRow extends { id: string }>(
	row: TRow,
	options: MediaFileAttachmentOptions<F>,
): Promise<(TRow & WithMediaFiles) | undefined> {
	const rows = await findManyWithMediaFiles([row], options);

	return rows[0];
}
