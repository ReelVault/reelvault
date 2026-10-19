import type { FieldsConfig } from "@reelvault/sdk/common";
import { eq, getTableColumns, inArray, type SQL, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { serverConstants } from "@/config/server/server.constants";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import type { DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import { QueryFields } from "@/integrations/drizzle-orm/query/parsing/fields.parser";
import { createPreparedQuery } from "@/integrations/drizzle-orm/query/prepared-queries.utils";
import { mapChunked } from "@/integrations/drizzle-orm/query/table-access/chunking.utils";
import { pickColumns } from "@/integrations/drizzle-orm/query/table-access/field-projection.utils";
import {
	aliasedColumns,
	booleanKeysOf,
	dateKeysOf,
	orderedJsonArray,
	parseJsonRelationArray,
} from "@/integrations/drizzle-orm/utils/relation-json.utils";
import { groupBy } from "@/utils/array.utils";

/**
 * The media file columns, straight from the schema: a hand-kept list of them
 * silently dropped every column added to the table later.
 */
const mediaFileColumns = getTableColumns(schema.mediaFiles);

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

const mediaFileIdsSubquery = sql`(SELECT value FROM json_each(${sql.placeholder("ids")}))`;

type MediaFileProjectionClient = ReturnType<typeof databaseFactory.getClient>;

/** Default-projection relation reads are fixed SQL: prepared once per connection, not rebuilt per read. */
const preparedMediaFilesByRelation = {
	movieId: createPreparedQuery((client: MediaFileProjectionClient) =>
		client.select().from(schema.mediaFiles).where(inArray(schema.mediaFiles.movieId, mediaFileIdsSubquery)).prepare(),
	),
	episodeId: createPreparedQuery((client: MediaFileProjectionClient) =>
		client.select().from(schema.mediaFiles).where(inArray(schema.mediaFiles.episodeId, mediaFileIdsSubquery)).prepare(),
	),
	libraryId: createPreparedQuery((client: MediaFileProjectionClient) =>
		client.select().from(schema.mediaFiles).where(inArray(schema.mediaFiles.libraryId, mediaFileIdsSubquery)).prepare(),
	),
};

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
	const ids = rows.map((row) => row.id);
	const mediaFiles = projection
		? await client.select(projection).from(schema.mediaFiles).where(inArray(schema.mediaFiles[options.relation], ids))
		: await preparedMediaFilesByRelation[options.relation](client).execute({ ids: JSON.stringify(ids) });
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

const mediaFileRowKeys = Object.keys(mediaFileColumns);
const mediaFileRevive = { booleanKeys: booleanKeysOf(mediaFileColumns), dateKeys: dateKeysOf(mediaFileColumns) };

/**
 * One parent row's media files as a JSON array. `ORDER BY rowid` keeps the
 * insertion order the batched read produced through the foreign-key index.
 */
export function mediaFilesJsonArray(relationColumn: SQLiteColumn, parentIdColumn: SQLiteColumn): SQL<string> {
	const { selectList, pairs } = aliasedColumns(mediaFileColumns, "");
	const from = sql`${schema.mediaFiles} WHERE ${relationColumn} = ${parentIdColumn}`;

	return orderedJsonArray(selectList, pairs, from, sql`${schema.mediaFiles}.rowid`);
}

/**
 * Single-id episode read: the episode row and its media files come back from
 * one statement, replacing the row read plus the attachment query behind
 * `findFirstWithMediaFiles`.
 */
export const preparedEpisodeWithMediaFiles = createPreparedQuery((client: MediaFileProjectionClient) =>
	client
		.select({
			data: getTableColumns(schema.episodes),
			mediaFiles: mediaFilesJsonArray(schema.mediaFiles.episodeId, schema.episodes.id),
		})
		.from(schema.episodes)
		.where(eq(schema.episodes.id, sql.placeholder("id")))
		.prepare(),
);

/** Row shape returned by {@link preparedEpisodeWithMediaFiles}. */
export interface MergedEpisodeMediaFilesRow {
	data: typeof schema.episodes.$inferSelect;
	mediaFiles: string;
}

/** Reads the single-id episode bundle back into the `EpisodeWithRelations` shape. */
export function parseEpisodeWithMediaFiles(row: MergedEpisodeMediaFilesRow): typeof schema.episodes.$inferSelect & WithMediaFiles {
	return {
		...row.data,
		mediaFiles: parseJsonRelationArray<typeof schema.mediaFiles.$inferSelect>(row.mediaFiles, mediaFileRowKeys, mediaFileRevive),
	};
}
