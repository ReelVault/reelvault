import { asc, eq, gt, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { collectKeysetPages } from "@/integrations/drizzle-orm/query/keyset/keyset-pages.utils";
import { QueryFields } from "@/integrations/drizzle-orm/query/parsing/fields.parser";
import { findByPrimaryId } from "./queries.reader";
import { AUDIT_ROW_PAGE_SIZE, type MediaFileAuditRow, mediaFileAuditProjection, streamingDurationCache } from "./shared.utils";

export async function findForTechnicalRefresh(mediaFileId: string) {
	return await findByPrimaryId({
		primaryId: mediaFileId,
		fields: QueryFields.parse({ fields: "id,libraryId,filePath,size,sourceMtimeMs,audioStreams" }),
	});
}

export async function findForPlaybackSession(mediaFileId: string) {
	return await findByPrimaryId({
		primaryId: mediaFileId,
		fields: QueryFields.parse({ fields: "id,filePath,duration,size,sourceMtimeMs,videoStreams,audioStreams,subtitles,isEnabled" }),
	});
}

export async function findForStreamingDuration(mediaFileId: string) {
	const cached = streamingDurationCache.get(mediaFileId);
	if (cached) return cached;

	const record = await findByPrimaryId({
		primaryId: mediaFileId,
		fields: QueryFields.parse({ fields: "id,duration" }),
	});
	if (record) {
		streamingDurationCache.set(mediaFileId, record);
	}

	return record;
}

export async function findForStreamingDiagnostics(mediaFileId: string) {
	return await findByPrimaryId({
		primaryId: mediaFileId,
		fields: QueryFields.parse({ fields: "id,fileName,formatName,duration,size,bitRate,videoStreams,audioStreams" }),
	});
}

export async function findForSubtitleExtraction(mediaFileId: string) {
	return await findByPrimaryId({
		primaryId: mediaFileId,
		fields: QueryFields.parse({ fields: "id,filePath" }),
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
