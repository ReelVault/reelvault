import type {
	FieldsConfig,
	FieldsQuery,
	MediaFileFilters,
	MediaFileSorting,
	MediaFileWithRelation,
	PaginatedResponse,
	PaginationQuery,
	SelectFields,
} from "@reelvault/sdk/common";
import { and, asc, eq, gt, inArray, isNull, type SQL } from "drizzle-orm";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import type { DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import { collectKeysetPages } from "@/integrations/drizzle-orm/query/keyset/keyset-pages.utils";
import { QueryFields } from "@/integrations/drizzle-orm/query/parsing/fields.parser";
import { mapChunked } from "@/integrations/drizzle-orm/query/table-access/chunking.utils";
import { selectManyWithFields } from "@/integrations/drizzle-orm/query/table-access/field-projection.utils";
import { findPageWithQueryMap } from "@/integrations/drizzle-orm/query/table-access/reads.reader";
import { parseFieldsForRead } from "@/integrations/drizzle-orm/query/table-access/table-access.factory";
import type { ProjectedSelectParams } from "@/integrations/drizzle-orm/query/table-access/table-access.types";
import { findCleanupDataForMediaFileIds } from "@/integrations/drizzle-orm/utils/media-cleanup.reader";
import { buildRelationProjection } from "@/integrations/drizzle-orm/utils/media-file-projection.builder";
import { unique } from "@/utils/array.utils";

import {
	AUDIT_ROW_PAGE_SIZE,
	assembleRelations,
	audioStreamColumns,
	canUseRelationBundle,
	type LoadedMediaFileRelations,
	libraryColumns,
	mediaFileQueryMap,
	mediaFiles,
	parseMediaFileRelations,
	parseMediaFileWithRelations,
	preparedAudioStreams,
	preparedLibraries,
	preparedMediaFileRelations,
	preparedMediaFileWithRelations,
	preparedSubtitles,
	preparedVideoStreams,
	subtitleColumns,
	videoStreamColumns,
} from "./shared.utils";

export async function findPage<F extends string>(
	query?: PaginationQuery & FieldsQuery<F> & MediaFileFilters & MediaFileSorting,
): Promise<PaginatedResponse<SelectFields<MediaFileWithRelation, F>>> {
	return await findPageWithQueryMap({
		access: mediaFiles,
		queryMap: mediaFileQueryMap,
		query,
		findMany: (params) => findMany(params),
	});
}

export async function findByIdForRead<F extends string>(mediaFileId: string, query?: FieldsQuery<F>) {
	return await findByPrimaryId({ primaryId: mediaFileId, fields: parseFieldsForRead(query) });
}

export async function findIdByFilePath(filePath: string) {
	return await findByFilePath({ filePath, fields: QueryFields.parse({ fields: "id" }) });
}

/** Lightweight connectivity probe for the health endpoint. */
export async function ping(): Promise<void> {
	// Liveness probe: one narrow indexed row instead of a full SELECT * LIMIT 1.
	await databaseFactory.getClient().select({ id: mediaFiles.primaryKeyColumn }).from(schema.mediaFiles).limit(1);
}

/**
 * Get all media files with pagination
 */
export async function findMany<F extends string>({
	fields,
	where,
	orderBy,
	limit,
	offset,
	tx,
}: ProjectedSelectParams<F>): Promise<Array<SelectFields<MediaFileWithRelation, F>>> {
	// Field-projected root rows skip the widest columns (filePath, formatName,
	// …) right in SQL; id+libraryId are required so loadRelations can anchor.
	const projectionParams = { fields, required: ["id", "libraryId"], where, orderBy, limit, offset, tx };
	let data: Awaited<ReturnType<typeof mediaFiles.selectMany>>;
	if (fields?.fields.length) {
		data = await selectManyWithFields(mediaFiles, projectionParams);
	} else {
		data = await mediaFiles.selectMany({ where, orderBy, limit, offset, tx });
	}
	const related = await loadRelations(data, tx, fields);

	const results: Array<SelectFields<MediaFileWithRelation, F>> = [];
	for (const item of data) {
		const rel = related.get(item.id);
		if (!rel) continue;

		results.push(QueryFields.apply<MediaFileWithRelation, F>({ ...item, ...rel }, fields));
	}

	return results;
}

/** All flat media-file rows of a title, zero relation queries. findMany
 * without fields loads video/audio streams + subtitles + library per batch —
 * composite views shipping only root rows must use this. */
export async function findRootsByMetadataId(metadataId: string): Promise<Array<typeof schema.mediaFiles.$inferSelect>> {
	return await mediaFiles.selectMany({ where: eq(schema.mediaFiles.metadataId, metadataId) });
}

/** Streams media-file identities page-by-page to `onPage`, returning the total. */
export async function scanAllIdentities(
	onPage: (rows: Array<{ id: string; metadataId: string }>) => Promise<void> | void,
): Promise<number> {
	return await collectKeysetPages({
		pageSize: AUDIT_ROW_PAGE_SIZE,
		fetchPage: (cursor) =>
			databaseFactory
				.getClient()
				.select({ id: schema.mediaFiles.id, metadataId: schema.mediaFiles.metadataId })
				.from(schema.mediaFiles)
				.where(cursor ? gt(schema.mediaFiles.id, cursor) : undefined)
				.orderBy(asc(schema.mediaFiles.id))
				.limit(AUDIT_ROW_PAGE_SIZE),
		onPage,
	});
}

export async function findIdentity(id: string, tx?: DatabaseTransaction): Promise<{ id: string; metadataId: string } | undefined> {
	const [row] = await databaseFactory
		.getClient({ tx })
		.select({ id: schema.mediaFiles.id, metadataId: schema.mediaFiles.metadataId })
		.from(schema.mediaFiles)
		.where(eq(schema.mediaFiles.id, id))
		.limit(1);

	return row;
}

/** Batched findIdentity — a scan enqueueing refreshes for N changed files
 * used to run one single-row SELECT per file at bounded concurrency. */
export async function findIdentitiesByIds(
	ids: readonly string[],
	tx?: DatabaseTransaction,
): Promise<Array<{ id: string; metadataId: string }>> {
	if (ids.length === 0) return [];

	return await mapChunked(ids, (chunkIds) =>
		databaseFactory
			.getClient({ tx })
			.select({ id: schema.mediaFiles.id, metadataId: schema.mediaFiles.metadataId })
			.from(schema.mediaFiles)
			.where(inArray(schema.mediaFiles.id, chunkIds)),
	);
}

/** Which of the ids exist as media files — one read for bulk prechecks (chunked like every id list). */
export async function findExistingIds(ids: readonly string[]): Promise<Set<string>> {
	const uniqueIds = [...new Set(ids)];
	if (uniqueIds.length === 0) return new Set();

	const rows = await mapChunked(uniqueIds, (chunkIds) =>
		databaseFactory.getClient().select({ id: schema.mediaFiles.id }).from(schema.mediaFiles).where(inArray(schema.mediaFiles.id, chunkIds)),
	);

	return new Set(rows.map((row) => row.id));
}

/**
 * Get a single media file by ID
 */
export async function findByPrimaryId<F extends string>({
	primaryId,
	fields,
	tx,
}: {
	primaryId: string;
	fields?: FieldsConfig<F> | undefined;
	tx?: DatabaseTransaction | undefined;
}): Promise<SelectFields<MediaFileWithRelation, F> | undefined> {
	// Single-row bundle: the row and its relations in one statement, so the
	// default read costs one query instead of row read + relation read.
	if (canUseRelationBundle(fields)) {
		const [row] = await preparedMediaFileWithRelations(databaseFactory.getClient({ tx })).execute({ id: primaryId });
		const merged = row ? parseMediaFileWithRelations(row) : undefined;
		if (!merged) return undefined;

		return QueryFields.apply<MediaFileWithRelation, F>(merged, fields);
	}

	const media = await mediaFiles.selectFirstById({ primaryId, tx });
	if (!media) return undefined;

	return await applyRelations(media, fields, tx);
}

/** The row with its relation bundle applied, projected to the requested fields. */
async function applyRelations<F extends string>(
	media: typeof schema.mediaFiles.$inferSelect,
	fields: FieldsConfig<F> | undefined,
	tx: DatabaseTransaction | undefined,
): Promise<SelectFields<MediaFileWithRelation, F> | undefined> {
	const relations = (await loadRelations([media], tx, fields)).get(media.id);
	if (!relations) return undefined;

	return QueryFields.apply<MediaFileWithRelation, F>({ ...media, ...relations }, fields);
}

/**
 * Get a media file by file path
 */
export async function findByFilePath<F extends string>({
	filePath,
	fields,
	tx,
}: {
	filePath: string;
	fields?: FieldsConfig<F> | undefined;
	tx?: DatabaseTransaction | undefined;
}): Promise<SelectFields<MediaFileWithRelation, F> | undefined> {
	return await findOneHydrated(eq(schema.mediaFiles.filePath, filePath), fields, tx);
}

/** Shared single-row read: flat row + relation bundle + field selection. */
async function findOneHydrated<F extends string>(
	where: SQL,
	fields?: FieldsConfig<F>,
	tx?: DatabaseTransaction,
): Promise<SelectFields<MediaFileWithRelation, F> | undefined> {
	const media = await mediaFiles.selectFirst({ where, tx });

	if (!media) return undefined;

	return await applyRelations(media, fields, tx);
}

/** Keyset page of file stats — the scanner diffs the library page-by-page instead of loading every row. */
export async function findStatsByLibraryIdPage(
	libraryId: string,
	afterId: string | undefined,
	limit: number,
	tx?: DatabaseTransaction,
): Promise<
	Array<{
		id: string;
		filePath: string;
		size: number | null;
		sourceMtimeMs: number | null;
	}>
> {
	return await databaseFactory
		.getClient({ tx })
		.select({
			id: schema.mediaFiles.id,
			filePath: schema.mediaFiles.filePath,
			size: schema.mediaFiles.size,
			sourceMtimeMs: schema.mediaFiles.sourceMtimeMs,
		})
		.from(schema.mediaFiles)
		.where(and(eq(schema.mediaFiles.libraryId, libraryId), afterId ? gt(schema.mediaFiles.id, afterId) : undefined))
		.orderBy(asc(schema.mediaFiles.id))
		.limit(limit);
}

export async function findByLibraryAndPaths({
	libraryId,
	filePaths,
	tx,
}: {
	libraryId: string;
	filePaths: string[];
	tx?: DatabaseTransaction;
}) {
	if (filePaths.length === 0) return [];

	return await mapChunked(filePaths, (pathChunk) =>
		mediaFiles.selectMany({
			where: and(eq(schema.mediaFiles.libraryId, libraryId), inArray(schema.mediaFiles.filePath, pathChunk)),
			tx,
		}),
	);
}

export async function findCleanupDataByMediaFileIds(mediaFileIds: readonly string[], tx?: DatabaseTransaction) {
	return await findCleanupDataForMediaFileIds(mediaFileIds, tx);
}

export async function findCleanupData(mediaFileId: string, tx?: DatabaseTransaction) {
	return await findCleanupDataForMediaFileIds([mediaFileId], tx);
}

/**
 * Loads video/audio streams and the parent library for a set of media files.
 *
 * Takes the already-fetched media file rows (not just their IDs) so it can read `libraryId`
 * directly off them — previously this ran a second `SELECT * FROM media_files WHERE id IN (...)`
 * purely to recover `libraryId`, duplicating a query the caller had already made.
 */
/** The per-relation projections the field config asks for. */
function relationProjections<F extends string>(fields?: FieldsConfig<F>) {
	let videoProjection: typeof videoStreamColumns | undefined;
	if (fields?.relations.videoStreams?.length) {
		videoProjection = buildRelationProjection(fields.relations.videoStreams, videoStreamColumns, ["mediaFileId"]);
	}
	let audioProjection: typeof audioStreamColumns | undefined;
	if (fields?.relations.audioStreams?.length) {
		audioProjection = buildRelationProjection(fields.relations.audioStreams, audioStreamColumns, ["mediaFileId"]);
	}
	let libraryProjection: typeof libraryColumns | undefined;
	if (fields?.relations.library?.length) {
		libraryProjection = buildRelationProjection(fields.relations.library, libraryColumns, ["id"]);
	}
	let subtitleProjection: typeof subtitleColumns | undefined;
	if (fields?.relations.subtitles?.length) {
		subtitleProjection = buildRelationProjection(fields.relations.subtitles, subtitleColumns, ["mediaFileId"]);
	}

	return { videoProjection, audioProjection, libraryProjection, subtitleProjection };
}

async function loadRelations<F extends string>(
	mediaFileRows: Array<{ id: string; libraryId: string }>,
	tx: DatabaseTransaction | undefined,
	fields?: FieldsConfig<F>,
): Promise<Map<string, LoadedMediaFileRelations>> {
	if (mediaFileRows.length === 0) return new Map();

	const mediaFileIds = mediaFileRows.map((mediaFile) => mediaFile.id);
	const client = databaseFactory.getClient({ tx });
	const { videoProjection, audioProjection, libraryProjection, subtitleProjection } = relationProjections(fields);
	// Single-row bundle: one statement replaces the four batched reads when the
	// anchor is a single file and every relation is on the default projection.
	const onlyRow = mediaFileRows.length === 1 ? mediaFileRows[0] : undefined;
	if (onlyRow && canUseRelationBundle(fields)) {
		const [row] = await preparedMediaFileRelations(client).execute({ id: onlyRow.id });
		const relations = row ? parseMediaFileRelations(onlyRow, row) : undefined;

		return relations ? new Map([[onlyRow.id, relations]]) : new Map();
	}

	// The relation bundle must be complete for every row (see LoadedMediaFileRelations):
	// callers omit rows whose relations did not load, so `library` has to be fetched
	// even when the field projection excludes it. Skipping it here made every
	// projected read (e.g. mediaFileFields without `library`) return "not found".
	const libraryIds = unique(mediaFileRows, (mediaFile) => mediaFile.libraryId);
	const mediaFileIdsJson = JSON.stringify(mediaFileIds);
	const libraryIdsJson = JSON.stringify(libraryIds);

	let videoStreamsQuery: PromiseLike<Array<typeof schema.mediaFileVideoStreams.$inferSelect>>;
	if (videoProjection) {
		videoStreamsQuery = client
			.select(videoProjection)
			.from(schema.mediaFileVideoStreams)
			.where(inArray(schema.mediaFileVideoStreams.mediaFileId, mediaFileIds));
	} else if (QueryFields.includes(fields, "videoStreams")) {
		videoStreamsQuery = preparedVideoStreams(client).execute({ ids: mediaFileIdsJson });
	} else {
		videoStreamsQuery = Promise.resolve([]);
	}

	let audioStreamsQuery: PromiseLike<Array<typeof schema.mediaFileAudioStreams.$inferSelect>>;
	if (audioProjection) {
		audioStreamsQuery = client
			.select(audioProjection)
			.from(schema.mediaFileAudioStreams)
			.where(inArray(schema.mediaFileAudioStreams.mediaFileId, mediaFileIds));
	} else if (QueryFields.includes(fields, "audioStreams")) {
		audioStreamsQuery = preparedAudioStreams(client).execute({ ids: mediaFileIdsJson });
	} else {
		audioStreamsQuery = Promise.resolve([]);
	}

	let librariesQuery: PromiseLike<Array<MediaFileWithRelation["library"]>>;
	if (libraryProjection) {
		librariesQuery = client.select(libraryProjection).from(schema.libraries).where(inArray(schema.libraries.id, libraryIds));
	} else if (libraryIds.length > 0) {
		librariesQuery = preparedLibraries(client).execute({ ids: libraryIdsJson });
	} else {
		librariesQuery = Promise.resolve([]);
	}

	let subtitlesQuery: PromiseLike<Array<typeof schema.subtitles.$inferSelect>>;
	if (subtitleProjection) {
		subtitlesQuery = client.select(subtitleProjection).from(schema.subtitles).where(inArray(schema.subtitles.mediaFileId, mediaFileIds));
	} else if (QueryFields.includes(fields, "subtitles")) {
		subtitlesQuery = preparedSubtitles(client).execute({ ids: mediaFileIdsJson });
	} else {
		subtitlesQuery = Promise.resolve([]);
	}

	const [videoStreams, audioStreams, subtitles, libraries] = await Promise.all([
		videoStreamsQuery,
		audioStreamsQuery,
		subtitlesQuery,
		librariesQuery,
	]);

	return assembleRelations(mediaFileRows, { videoStreams, audioStreams, subtitles, libraries });
}

/**
 * Find media files whose `libraryId` references a non-existent library.
 * Returns IDs in batches to avoid unbounded memory.
 */
export async function findOrphanedMediaFileIds(batchSize = 500, tx?: DatabaseTransaction): Promise<string[]> {
	const client = databaseFactory.getClient({ tx });
	const orphanedIds: string[] = [];
	await collectKeysetPages({
		pageSize: batchSize,
		fetchPage: (cursor) =>
			client
				.select({ id: schema.mediaFiles.id })
				.from(schema.mediaFiles)
				.leftJoin(schema.libraries, eq(schema.mediaFiles.libraryId, schema.libraries.id))
				.where(cursor ? and(isNull(schema.libraries.id), gt(schema.mediaFiles.id, cursor)) : isNull(schema.libraries.id))
				.orderBy(asc(schema.mediaFiles.id))
				.limit(batchSize),
		onPage: (batch) => {
			for (const row of batch) orphanedIds.push(row.id);
		},
	});

	return orphanedIds;
}

/** Media file ids of the given titles; a title's delete is held back while a stream plays one of these files. */
export async function findIdsByMetadataIds(metadataIds: readonly string[]): Promise<string[]> {
	if (metadataIds.length === 0) return [];

	const rows = await mapChunked([...metadataIds], (idChunk) =>
		databaseFactory
			.getClient()
			.select({ id: schema.mediaFiles.id })
			.from(schema.mediaFiles)
			.where(inArray(schema.mediaFiles.metadataId, idChunk)),
	);

	return rows.map((row) => row.id);
}
