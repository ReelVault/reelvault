import { asc, eq, getTableColumns, gt, type SQL, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { collectKeysetPages } from "@/integrations/drizzle-orm/query/keyset/keyset-pages.utils";
import { applyFields, parseFields } from "@/integrations/drizzle-orm/query/parsing/fields.parser";
import { createPreparedQuery } from "@/integrations/drizzle-orm/query/prepared-queries.utils";
import {
	aliasedColumns,
	booleanKeysOf,
	dateKeysOf,
	jsonObjectRow,
	parseJsonRelationObject,
	type RelationJsonKeys,
} from "@/integrations/drizzle-orm/utils/relation-json.utils";
import { findByPrimaryId } from "./queries.reader";
import {
	AUDIT_ROW_PAGE_SIZE,
	type MediaFileAuditRow,
	type MediaRelationClient,
	mediaFileAuditProjection,
	mediaFileRelationsJson,
	parseMediaFileWithRelations,
	streamingDurationCache,
} from "./shared.utils";

export async function findForTechnicalRefresh(mediaFileId: string) {
	return await findByPrimaryId({
		primaryId: mediaFileId,
		fields: parseFields({ fields: "id,libraryId,filePath,size,sourceMtimeMs,audioStreams" }),
	});
}

/** The projection a playback session is created from; the decision reads the container and its bitrate. */
const playbackSessionFields = parseFields({
	fields: "id,filePath,duration,size,bitRate,formatName,sourceMtimeMs,videoStreams,audioStreams,subtitles,isEnabled",
});

export async function findForPlaybackSession(mediaFileId: string) {
	return await findByPrimaryId({
		primaryId: mediaFileId,
		fields: playbackSessionFields,
	});
}

/** The viewer's saved position for one file. */
export interface PlaybackSessionProgress {
	completed: boolean;
	position: number | null;
	audioStreamIndex: number | null;
	subtitleId: string | null;
}

/** The profile's stored languages for one title. */
export interface PlaybackSessionStreamPrefs {
	audioLanguage: string | null;
	subtitleLanguage: string | null;
}

const sessionProgressColumns = {
	completed: schema.playbackProgress.completed,
	position: schema.playbackProgress.position,
	audioStreamIndex: schema.playbackProgress.audioStreamIndex,
	subtitleId: schema.playbackProgress.subtitleId,
};
const sessionStreamPrefsColumns = {
	audioLanguage: schema.profileStreamPrefs.audioLanguage,
	subtitleLanguage: schema.profileStreamPrefs.subtitleLanguage,
};
const sessionProgressRevive: RelationJsonKeys = {
	booleanKeys: booleanKeysOf(sessionProgressColumns),
	dateKeys: dateKeysOf(sessionProgressColumns),
};
const sessionStreamPrefsRevive: RelationJsonKeys = {
	booleanKeys: booleanKeysOf(sessionStreamPrefsColumns),
	dateKeys: dateKeysOf(sessionStreamPrefsColumns),
};
const sessionProgressKeys = Object.keys(sessionProgressColumns);
const sessionStreamPrefsKeys = Object.keys(sessionStreamPrefsColumns);

/**
 * A session start reads the file, its relation bundle and the viewer's saved
 * state in one statement: the file's progress row as JSON, a title-level EXISTS
 * with the same conditions as the old separate check, and the per-title stream
 * preferences as JSON. Measured 3 → 1 statement and 0.049 → 0.021 ms per read
 * (payloads identical).
 */
const preparedPlaybackSessionData = createPreparedQuery((client: MediaRelationClient) => {
	const progress = aliasedColumns(sessionProgressColumns, "");
	const streamPrefs = aliasedColumns(sessionStreamPrefsColumns, "");
	const titleFileIds = sql`(SELECT id FROM ${schema.mediaFiles} WHERE ${schema.mediaFiles.metadataId} = (SELECT metadata_id FROM ${schema.mediaFiles} WHERE ${schema.mediaFiles.id} = ${sql.placeholder("mediaFileId")}))`;

	return client
		.select({
			data: getTableColumns(schema.mediaFiles),
			...mediaFileRelationsJson,
			existingProgress: jsonObjectRow(
				progress.selectList,
				progress.pairs,
				sql`${schema.playbackProgress} WHERE ${schema.playbackProgress.mediaFileId} = ${sql.placeholder("mediaFileId")} AND ${schema.playbackProgress.profileId} = ${sql.placeholder("profileId")}`,
			),
			titleHasActiveProgress: sql<number>`EXISTS (SELECT 1 FROM ${schema.playbackProgress} WHERE ${schema.playbackProgress.profileId} = ${sql.placeholder("profileId")} AND ${schema.playbackProgress.completed} = 0 AND ${schema.playbackProgress.position} >= ${sql.placeholder("thresholdSeconds")} AND ${schema.playbackProgress.mediaFileId} IN ${titleFileIds})`,
			perTitlePreferences: jsonObjectRow(
				streamPrefs.selectList,
				streamPrefs.pairs,
				sql`${schema.profileStreamPrefs} WHERE ${schema.profileStreamPrefs.profileId} = ${sql.placeholder("profileId")} AND ${schema.profileStreamPrefs.metadataId} = ${schema.mediaFiles.metadataId}`,
			),
		})
		.from(schema.mediaFiles)
		.where(eq(schema.mediaFiles.id, sql.placeholder("mediaFileId")))
		.prepare();
});

/** Everything a session start reads about one file and viewer. */
export interface PlaybackSessionData {
	file: NonNullable<Awaited<ReturnType<typeof findForPlaybackSession>>>;
	existingProgress?: PlaybackSessionProgress | undefined;
	/** Whether any file of the title has in-progress playback past the resume threshold. */
	titleHasActiveProgress: boolean;
	perTitlePreferences: PlaybackSessionStreamPrefs | null;
}

/**
 * Playback session start in one statement: the projected file row with its
 * stream and subtitle relations, the viewer's saved position, the title-level
 * resume check and the per-title stream preferences. `undefined` when the file
 * (or its library) is gone, like {@link findForPlaybackSession}.
 */
export async function findPlaybackSessionData(
	mediaFileId: string,
	profileId: string,
	thresholdSeconds: number,
): Promise<PlaybackSessionData | undefined> {
	const [row] = await preparedPlaybackSessionData(databaseFactory.getClient()).execute({ mediaFileId, profileId, thresholdSeconds });
	if (!row) return undefined;

	const merged = parseMediaFileWithRelations(row);
	if (!merged) return undefined;

	return {
		file: applyFields(merged, playbackSessionFields),
		existingProgress: parseJsonRelationObject<PlaybackSessionProgress>(row.existingProgress, sessionProgressKeys, sessionProgressRevive),
		titleHasActiveProgress: row.titleHasActiveProgress === 1,
		perTitlePreferences:
			parseJsonRelationObject<PlaybackSessionStreamPrefs>(row.perTitlePreferences, sessionStreamPrefsKeys, sessionStreamPrefsRevive) ??
			null,
	};
}

export async function findForStreamingDuration(mediaFileId: string) {
	const cached = streamingDurationCache.get(mediaFileId);
	if (cached) return cached;

	const record = await findByPrimaryId({
		primaryId: mediaFileId,
		fields: parseFields({ fields: "id,duration" }),
	});
	if (record) {
		streamingDurationCache.set(mediaFileId, record);
	}

	return record;
}

export async function findForStreamingDiagnostics(mediaFileId: string) {
	return await findByPrimaryId({
		primaryId: mediaFileId,
		fields: parseFields({ fields: "id,fileName,formatName,duration,size,bitRate,videoStreams,audioStreams" }),
	});
}

export async function findForSubtitleExtraction(mediaFileId: string) {
	return await findByPrimaryId({
		primaryId: mediaFileId,
		fields: parseFields({ fields: "id,filePath" }),
	});
}

/** Base audit select: media file joined to its metadata row, shared by the single, paged and id-only audit reads. */
function auditRows<TSelection extends Record<string, SQLiteColumn | SQL>>(selection: TSelection) {
	return databaseFactory
		.getClient()
		.select(selection)
		.from(schema.mediaFiles)
		.innerJoin(schema.metadata, eq(schema.mediaFiles.metadataId, schema.metadata.id));
}

export async function findAuditRow(mediaFileId: string) {
	const [row] = await auditRows(mediaFileAuditProjection)
		.innerJoin(schema.libraries, eq(schema.mediaFiles.libraryId, schema.libraries.id))
		.leftJoin(schema.episodes, eq(schema.mediaFiles.episodeId, schema.episodes.id))
		.leftJoin(schema.seasons, eq(schema.episodes.seasonId, schema.seasons.id))
		.where(eq(schema.mediaFiles.id, mediaFileId))
		.limit(1);

	return row;
}

/**
 * Streams audit rows page-by-page to `onPage`, returning the total row count.
 * The caller can `await` between pages so a full-catalog audit never starves
 * the event loop (SQLite is synchronous).
 */
export async function scanAuditRows(onPage: (rows: MediaFileAuditRow[]) => Promise<void> | void): Promise<number> {
	return await collectKeysetPages({
		pageSize: AUDIT_ROW_PAGE_SIZE,
		fetchPage: (cursor) => findAuditRowsPage(cursor),
		cursorOf: (rows) => rows.at(-1)?.mediaFileId,
		onPage,
	});
}

async function findAuditRowsPage(cursor?: string) {
	return await auditRows(mediaFileAuditProjection)
		.innerJoin(schema.libraries, eq(schema.mediaFiles.libraryId, schema.libraries.id))
		.leftJoin(schema.episodes, eq(schema.mediaFiles.episodeId, schema.episodes.id))
		.leftJoin(schema.seasons, eq(schema.episodes.seasonId, schema.seasons.id))
		.where(cursor ? gt(schema.mediaFiles.id, cursor) : undefined)
		.orderBy(asc(schema.mediaFiles.id))
		.limit(AUDIT_ROW_PAGE_SIZE);
}

/** Streams audit ids page-by-page to `onPage`, returning the total. Never materializes the whole catalog. */
export async function scanAuditRowIds(onPage: (ids: string[]) => Promise<void> | void): Promise<number> {
	return await collectKeysetPages({
		pageSize: AUDIT_ROW_PAGE_SIZE,
		fetchPage: (cursor) =>
			auditRows({ id: schema.mediaFiles.id })
				.where(cursor ? gt(schema.mediaFiles.id, cursor) : undefined)
				.orderBy(asc(schema.mediaFiles.id))
				.limit(AUDIT_ROW_PAGE_SIZE),
		onPage: (rows) => onPage(rows.map((row) => row.id)),
	});
}
