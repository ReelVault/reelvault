import type { CreateMediaFile, FieldsConfig, MediaFileFilters, MediaFileSorting, MediaFileWithRelation } from "@reelvault/sdk/common";
import { eq, getTableColumns, inArray, or, type SQL, type SQLChunk, sql } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { MINUTE } from "@/config/server/server.constants";
import type { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { includesField } from "@/integrations/drizzle-orm/query/parsing/fields.parser";
import { filterEquals, filterLike } from "@/integrations/drizzle-orm/query/parsing/filtering.parser";
import type { QueryMap } from "@/integrations/drizzle-orm/query/parsing/query.parser";
import { createPreparedQuery } from "@/integrations/drizzle-orm/query/prepared-queries.utils";
import { defineTableAccess } from "@/integrations/drizzle-orm/query/table-access/table-access.factory";
import {
	aliasedColumns,
	booleanKeysOf,
	dateKeysOf,
	jsonObjectRow,
	orderedJsonArray,
	parseJsonRelationArray,
	parseJsonRelationObject,
} from "@/integrations/drizzle-orm/utils/relation-json.utils";
import { groupBy, toMap } from "@/utils/array.utils";
import { createLogger } from "@/utils/logger.utils";
import { MemoryCache } from "@/utils/memory.cache";

const logger = createLogger("MediaFilesRepository");

export type MediaRelationClient = ReturnType<typeof databaseFactory.getClient>;

/**
 * Full-projection relation reads are fixed SQL: the id list travels as one JSON
 * parameter through `json_each`, so each statement is prepared once per
 * connection instead of being rebuilt for every page (measured 55.6 → 14.6 µs
 * for the four reads behind one media file).
 */
const idListSubquery = sql`(SELECT value FROM json_each(${sql.placeholder("ids")}))`;

export const preparedVideoStreams = createPreparedQuery((client: MediaRelationClient) =>
	client.select().from(schema.mediaFileVideoStreams).where(inArray(schema.mediaFileVideoStreams.mediaFileId, idListSubquery)).prepare(),
);

export const preparedAudioStreams = createPreparedQuery((client: MediaRelationClient) =>
	client.select().from(schema.mediaFileAudioStreams).where(inArray(schema.mediaFileAudioStreams.mediaFileId, idListSubquery)).prepare(),
);

export const preparedSubtitles = createPreparedQuery((client: MediaRelationClient) =>
	client.select().from(schema.subtitles).where(inArray(schema.subtitles.mediaFileId, idListSubquery)).prepare(),
);

export const preparedLibraries = createPreparedQuery((client: MediaRelationClient) =>
	client.select().from(schema.libraries).where(inArray(schema.libraries.id, idListSubquery)).prepare(),
);

/** Relation bundle as loaded from the database — only includes entries where ALL relations are present. */
export interface LoadedMediaFileRelations {
	videoStreams: Array<typeof schema.mediaFileVideoStreams.$inferSelect>;
	audioStreams: Array<typeof schema.mediaFileAudioStreams.$inferSelect>;
	subtitles: Array<typeof schema.subtitles.$inferSelect>;
	library: MediaFileWithRelation["library"];
}

/** Groups the loaded relation rows per media file. A file whose library is gone is left out of the result, but never silently. */
export function assembleRelations(
	mediaFileRows: Array<{ id: string; libraryId: string }>,
	loaded: {
		videoStreams: Array<typeof schema.mediaFileVideoStreams.$inferSelect>;
		audioStreams: Array<typeof schema.mediaFileAudioStreams.$inferSelect>;
		subtitles: Array<typeof schema.subtitles.$inferSelect>;
		libraries: Array<MediaFileWithRelation["library"]>;
	},
): Map<string, LoadedMediaFileRelations> {
	const { videoStreams, audioStreams, subtitles, libraries } = loaded;

	const librariesById = toMap(libraries, (library) => library.id);
	const libraryIdByMediaFileId = toMap(
		mediaFileRows,
		(mediaFile) => mediaFile.id,
		(mediaFile) => mediaFile.libraryId,
	);
	const videosByMediaFileId = groupBy(
		videoStreams.filter((item) => hasMediaFileId(item)),
		(item) => item.mediaFileId,
	);
	const audioByMediaFileId = groupBy(
		audioStreams.filter((item) => hasMediaFileId(item)),
		(item) => item.mediaFileId,
	);
	const subtitlesByMediaFileId = groupBy(
		subtitles.filter((item) => hasMediaFileId(item)),
		(item) => item.mediaFileId,
	);

	const result = new Map<string, LoadedMediaFileRelations>();
	for (const { id: mediaFileId } of mediaFileRows) {
		const libraryId = libraryIdByMediaFileId.get(mediaFileId) ?? "";
		const library = librariesById.get(libraryId);
		if (!library) {
			// Dangling libraryId (library removed out from under the row). The row
			// cannot satisfy MediaFileWithRelation's `library` contract, so it is
			// omitted from results — but never silently.
			logger.warn("Media file references a missing library — omitted from results", { mediaFileId, libraryId });
			continue;
		}

		result.set(mediaFileId, {
			videoStreams: videosByMediaFileId.get(mediaFileId) ?? [],
			audioStreams: audioByMediaFileId.get(mediaFileId) ?? [],
			subtitles: subtitlesByMediaFileId.get(mediaFileId) ?? [],
			library,
		});
	}

	return result;
}

function hasMediaFileId<T>(item: T): item is T & { mediaFileId: string } {
	return typeof item === "object" && item !== null && "mediaFileId" in item && typeof item.mediaFileId === "string";
}

export const mediaFiles = defineTableAccess("mediaFiles", {
	primaryKeyColumn: "id",
});
export const mediaFileVideoStreams = defineTableAccess("mediaFileVideoStreams", {
	primaryKeyColumn: "mediaFileId",
});
export const mediaFileAudioStreams = defineTableAccess("mediaFileAudioStreams", {
	primaryKeyColumn: "mediaFileId",
});
export const mediaFileSubtitles = defineTableAccess("subtitles", {
	primaryKeyColumn: "id",
});
export const videoStreamColumns = getTableColumns(schema.mediaFileVideoStreams);
export const audioStreamColumns = getTableColumns(schema.mediaFileAudioStreams);
export const subtitleColumns = getTableColumns(schema.subtitles);
export const libraryColumns = {
	id: schema.libraries.id,
	name: schema.libraries.name,
	type: schema.libraries.type,
	createdAt: schema.libraries.createdAt,
	updatedAt: schema.libraries.updatedAt,
};

/**
 * Single-row relation bundle: the whole graph of one media file as JSON in one
 * statement, for reads anchored on a single id (`getById`, `findByFilePath`).
 * Pages keep the four batched reads below — one scan per relation across the id
 * list beats per-row correlated subqueries there (measured), while a single row
 * has nothing to batch.
 */
const libraryTableColumns = getTableColumns(schema.libraries);

function mediaRelationJsonArray(
	columns: Record<string, SQLiteColumn>,
	table: SQLiteTable,
	where: SQLChunk,
	orderBy: SQLChunk,
): SQL<string> {
	const { selectList, pairs } = aliasedColumns(columns, "");

	return orderedJsonArray(selectList, pairs, sql`${table} WHERE ${where}`, orderBy);
}

export const mediaFileRelationsJson = {
	videoStreams: mediaRelationJsonArray(
		videoStreamColumns,
		schema.mediaFileVideoStreams,
		sql`${schema.mediaFileVideoStreams.mediaFileId} = ${schema.mediaFiles.id}`,
		schema.mediaFileVideoStreams.index,
	),
	audioStreams: mediaRelationJsonArray(
		audioStreamColumns,
		schema.mediaFileAudioStreams,
		sql`${schema.mediaFileAudioStreams.mediaFileId} = ${schema.mediaFiles.id}`,
		schema.mediaFileAudioStreams.index,
	),
	subtitles: mediaRelationJsonArray(
		subtitleColumns,
		schema.subtitles,
		sql`${schema.subtitles.mediaFileId} = ${schema.mediaFiles.id}`,
		schema.subtitles.createdAt,
	),
	library: (() => {
		const { selectList, pairs } = aliasedColumns(libraryTableColumns, "");
		const from = sql`${schema.libraries} WHERE ${schema.libraries.id} = ${schema.mediaFiles.libraryId}`;

		return jsonObjectRow(selectList, pairs, from);
	})(),
};

export const preparedMediaFileRelations = createPreparedQuery((client: MediaRelationClient) =>
	client
		.select(mediaFileRelationsJson)
		.from(schema.mediaFiles)
		.where(eq(schema.mediaFiles.id, sql.placeholder("id")))
		.prepare(),
);

/**
 * Single-id media read: the row and its relation bundle in one statement
 * (the episode bundle's shape), so `findByIdForRead`/`getById` cost one
 * statement instead of a row read plus the relation read. The row rides as
 * plain columns, so drizzle still maps its types; only the relations are JSON.
 */
export const preparedMediaFileWithRelations = createPreparedQuery((client: MediaRelationClient) =>
	client
		.select({ data: getTableColumns(schema.mediaFiles), ...mediaFileRelationsJson })
		.from(schema.mediaFiles)
		.where(eq(schema.mediaFiles.id, sql.placeholder("id")))
		.prepare(),
);

/** Row shape returned by {@link preparedMediaFileWithRelations}. */
export interface MergedMediaFileRelationsRow extends MediaFileRelationsRow {
	data: typeof schema.mediaFiles.$inferSelect;
}

/** Reads the single-id bundle back into row + relations; `undefined` when the file's library row is gone. */
export function parseMediaFileWithRelations(
	row: MergedMediaFileRelationsRow,
): (typeof schema.mediaFiles.$inferSelect & LoadedMediaFileRelations) | undefined {
	const relations = parseMediaFileRelations(row.data, row);

	return relations ? { ...row.data, ...relations } : undefined;
}

/**
 * True when the default relation bundle can serve a read: every stream relation
 * is requested and no relation has an explicit field projection. Shared by the
 * single-id bundle and the one-row branch of `loadRelations`.
 */
export function canUseRelationBundle<F extends string>(fields?: FieldsConfig<F>): boolean {
	const projected = Object.values(fields?.relations ?? {}).some((relation) => relation.length > 0);

	return !projected && includesField(fields, "videoStreams") && includesField(fields, "audioStreams") && includesField(fields, "subtitles");
}

export interface MediaFileRelationsRow {
	videoStreams: string;
	audioStreams: string;
	subtitles: string;
	library: string | null;
}

const videoStreamRevive = { booleanKeys: booleanKeysOf(videoStreamColumns), dateKeys: dateKeysOf(videoStreamColumns) };
const audioStreamRevive = { booleanKeys: booleanKeysOf(audioStreamColumns), dateKeys: dateKeysOf(audioStreamColumns) };
const subtitleRevive = { booleanKeys: booleanKeysOf(subtitleColumns), dateKeys: dateKeysOf(subtitleColumns) };
const libraryRevive = { booleanKeys: booleanKeysOf(libraryTableColumns), dateKeys: dateKeysOf(libraryTableColumns) };

/** Reads the single-row bundle back into DTO items; `undefined` when the file's library row is gone (logged, like `assembleRelations`). */
export function parseMediaFileRelations(
	mediaFile: { id: string; libraryId: string },
	row: MediaFileRelationsRow,
): LoadedMediaFileRelations | undefined {
	const library = parseJsonRelationObject<MediaFileWithRelation["library"]>(row.library, Object.keys(libraryTableColumns), libraryRevive);
	if (!library) {
		logger.warn("Media file references a missing library — omitted from results", {
			mediaFileId: mediaFile.id,
			libraryId: mediaFile.libraryId,
		});

		return undefined;
	}

	return {
		videoStreams: parseJsonRelationArray<typeof schema.mediaFileVideoStreams.$inferSelect>(
			row.videoStreams,
			Object.keys(videoStreamColumns),
			videoStreamRevive,
		),
		audioStreams: parseJsonRelationArray<typeof schema.mediaFileAudioStreams.$inferSelect>(
			row.audioStreams,
			Object.keys(audioStreamColumns),
			audioStreamRevive,
		),
		subtitles: parseJsonRelationArray<typeof schema.subtitles.$inferSelect>(row.subtitles, Object.keys(subtitleColumns), subtitleRevive),
		library,
	};
}

export const mediaFileAuditProjection = {
	mediaFileId: schema.mediaFiles.id,
	fileName: schema.mediaFiles.fileName,
	filePath: schema.mediaFiles.filePath,
	libraryId: schema.mediaFiles.libraryId,
	libraryName: schema.libraries.name,
	libraryType: schema.libraries.type,
	metadataId: schema.metadata.id,
	metadataTitle: schema.metadata.title,
	metadataOriginalTitle: schema.metadata.originalTitle,
	metadataReleaseDate: schema.metadata.releaseDate,
	metadataMatchScore: schema.metadata.matchScore,
	metadataType: schema.metadata.type,
	episodeNumber: schema.episodes.episodeNumber,
	seasonNumber: schema.seasons.seasonNumber,
};

export interface MediaFileAuditRow {
	mediaFileId: string;
	fileName: string;
	filePath: string;
	libraryId: string;
	libraryName: string | null;
	libraryType: string;
	metadataId: string;
	metadataTitle: string;
	metadataOriginalTitle: string | null;
	metadataReleaseDate: string | null;
	metadataMatchScore: number | null;
	metadataType: string;
	episodeNumber: number | null;
	seasonNumber: number | null;
}

export const AUDIT_ROW_PAGE_SIZE = 1000;

export const mediaFileQueryMap: QueryMap<MediaFileFilters, MediaFileSorting> = {
	filters: {
		libraryId: (value: string) => filterEquals(schema.mediaFiles.libraryId, value),
		metadataId: (value: string) => filterEquals(schema.mediaFiles.metadataId, value),
		movieId: (value: string) => filterEquals(schema.mediaFiles.movieId, value),
		episodeId: (value: string) => filterEquals(schema.mediaFiles.episodeId, value),
		filePath: (value: string) => filterLike(schema.mediaFiles.filePath, value),
		fileName: (value: string) =>
			or(
				filterLike(schema.mediaFiles.fileName, value),
				filterLike(schema.mediaFiles.filePath, value),
				filterLike(schema.mediaFiles.id, value),
			),
	},
	orderBy: {
		fileName: schema.mediaFiles.fileName,
		filePath: schema.mediaFiles.filePath,
		size: schema.mediaFiles.size,
		createdAt: schema.mediaFiles.createdAt,
		updatedAt: schema.mediaFiles.updatedAt,
	},
	defaults: { sortBy: "createdAt", sortOrder: "desc" },
};

export type TechnicalMediaFileData = Pick<
	CreateMediaFile,
	"formatName" | "duration" | "bitRate" | "source" | "edition" | "qualityTag" | "videoStreams" | "audioStreams" | "subtitles"
>;

export const streamingDurationCache = new MemoryCache<{ id: string; duration: number | null }>({
	ttlMs: 30 * MINUTE,
	maxSize: 5000,
	name: "media-file-streaming-duration",
});
