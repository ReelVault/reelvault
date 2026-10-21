import { and, eq, inArray, sql } from "drizzle-orm";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import type { DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import { createPreparedQuery } from "@/integrations/drizzle-orm/query/prepared-queries.utils";
import { mapChunked } from "@/integrations/drizzle-orm/query/table-access/chunking.utils";
import { defineTableAccess } from "@/integrations/drizzle-orm/query/table-access/table-access.factory";
import { mediaFiles } from "@/repositories/media-files/shared.utils";
import { isNullish } from "@/utils/type.utils";

const playbackProgress = defineTableAccess("playbackProgress", { primaryKeyColumn: "id" });

/**
 * Fixed-shape playback queries (Faza 3 pilot). Inserts bind `id`/timestamps
 * explicitly because `$defaultFn` values freeze at `prepare()` time.
 */
const preparedFindProgressUpdateData = createPreparedQuery((client) =>
	client
		.select({
			id: schema.mediaFiles.id,
			duration: schema.mediaFiles.duration,
			metadataId: schema.mediaFiles.metadataId,
			completed: schema.playbackProgress.completed,
			position: schema.playbackProgress.position,
			audioStreamIndex: schema.playbackProgress.audioStreamIndex,
			subtitleId: schema.playbackProgress.subtitleId,
		})
		.from(schema.mediaFiles)
		.leftJoin(
			schema.playbackProgress,
			and(
				eq(schema.playbackProgress.mediaFileId, schema.mediaFiles.id),
				eq(schema.playbackProgress.profileId, sql.placeholder("profileId")),
			),
		)
		.where(eq(schema.mediaFiles.id, sql.placeholder("fileId")))
		.limit(1)
		.prepare(),
);

const preparedFindMediaFileWithMetadata = createPreparedQuery((client) =>
	client
		.select({
			id: schema.mediaFiles.id,
			metadataId: schema.mediaFiles.metadataId,
			movieId: schema.mediaFiles.movieId,
			episodeId: schema.mediaFiles.episodeId,
		})
		.from(schema.mediaFiles)
		.where(eq(schema.mediaFiles.id, sql.placeholder("fileId")))
		.limit(1)
		.prepare(),
);

/** The upsert statement with or without the audio/subtitle columns, so each shape is prepared once. */
function buildUpsertProgress(client: DatabaseTransaction, withAudio: boolean, withSubtitle: boolean) {
	const updateSet = {
		position: sql.placeholder("position"),
		duration: sql.placeholder("duration"),
		completed: sql.placeholder("completed"),
		updatedAt: sql.placeholder("updatedAt"),
		...(withAudio ? { audioStreamIndex: sql.placeholder("audioStreamIndex") } : {}),
		...(withSubtitle ? { subtitleId: sql.placeholder("subtitleId") } : {}),
	};

	return client
		.insert(schema.playbackProgress)
		.values({
			id: sql.placeholder("id"),
			profileId: sql.placeholder("profileId"),
			mediaFileId: sql.placeholder("fileId"),
			position: sql.placeholder("position"),
			duration: sql.placeholder("duration"),
			completed: sql.placeholder("completed"),
			audioStreamIndex: sql.placeholder("audioStreamIndex"),
			subtitleId: sql.placeholder("subtitleId"),
			createdAt: sql.placeholder("createdAt"),
			updatedAt: sql.placeholder("updatedAt"),
		})
		.onConflictDoUpdate({
			target: [schema.playbackProgress.profileId, schema.playbackProgress.mediaFileId],
			set: updateSet,
		})
		.prepare();
}

const preparedUpsertProgress = {
	audioSubtitle: createPreparedQuery((client) => buildUpsertProgress(client, true, true)),
	audio: createPreparedQuery((client) => buildUpsertProgress(client, true, false)),
	subtitle: createPreparedQuery((client) => buildUpsertProgress(client, false, true)),
	none: createPreparedQuery((client) => buildUpsertProgress(client, false, false)),
};

function selectUpsertProgressPrepared(hasAudio: boolean, hasSubtitle: boolean) {
	if (hasAudio && hasSubtitle) return preparedUpsertProgress.audioSubtitle;

	if (hasAudio) return preparedUpsertProgress.audio;

	if (hasSubtitle) return preparedUpsertProgress.subtitle;

	return preparedUpsertProgress.none;
}

/** Distinct profiles that have watched any file of this metadata row. */
export async function findViewerProfilesByMetadataId(metadataId: string): Promise<Array<{ profileId: string; userId: string }>> {
	return await databaseFactory
		.getClient()
		.select({ profileId: schema.playbackProgress.profileId, userId: schema.profiles.userId })
		.from(schema.playbackProgress)
		.innerJoin(schema.mediaFiles, eq(schema.mediaFiles.id, schema.playbackProgress.mediaFileId))
		.innerJoin(schema.profiles, eq(schema.profiles.id, schema.playbackProgress.profileId))
		.where(eq(schema.mediaFiles.metadataId, metadataId));
}

export async function findProgressUpdateData(fileId: string, profileId: string) {
	const [row] = await preparedFindProgressUpdateData(databaseFactory.getClient()).execute({ fileId, profileId });

	if (!row) {
		return { mediaFile: undefined, existingProgress: undefined };
	}

	return {
		mediaFile: { id: row.id, duration: row.duration, metadataId: row.metadataId },
		existingProgress: isNullish(row.completed)
			? undefined
			: {
					completed: row.completed,
					position: row.position,
					audioStreamIndex: row.audioStreamIndex,
					subtitleId: row.subtitleId,
				},
	};
}

export async function findMediaFileWithMetadata(fileId: string) {
	const [row] = await preparedFindMediaFileWithMetadata(databaseFactory.getClient()).execute({ fileId });

	return row;
}

/** The ids among `fileIds` that exist as media files. */
export async function findExistingMediaFileIds(fileIds: readonly string[]): Promise<Set<string>> {
	return await mediaFiles.findExistingIds(fileIds);
}

/** One file as the bulk watch-state write reads it: duration, title and the profile's current progress. */
export interface WatchStateBulkRow {
	id: string;
	duration: number | null;
	metadataId: string;
	completed: boolean | null;
	audioStreamIndex: number | null;
	subtitleId: string | null;
}

/**
 * Bulk watch-state source data: the files and the profile's progress in one
 * statement per chunk instead of one read per file (the bulk endpoint accepts
 * up to 500 ids). Rows exist only for known files, so this also serves the
 * not-found precheck.
 */
export async function findWatchStateBulkData(profileId: string, fileIds: readonly string[]): Promise<WatchStateBulkRow[]> {
	return await mapChunked([...fileIds], (chunkIds) =>
		databaseFactory
			.getClient()
			.select({
				id: schema.mediaFiles.id,
				duration: schema.mediaFiles.duration,
				metadataId: schema.mediaFiles.metadataId,
				completed: schema.playbackProgress.completed,
				audioStreamIndex: schema.playbackProgress.audioStreamIndex,
				subtitleId: schema.playbackProgress.subtitleId,
			})
			.from(schema.mediaFiles)
			.leftJoin(
				schema.playbackProgress,
				and(eq(schema.playbackProgress.mediaFileId, schema.mediaFiles.id), eq(schema.playbackProgress.profileId, profileId)),
			)
			.where(inArray(schema.mediaFiles.id, chunkIds)),
	);
}

export async function upsertProgress({
	profileId,
	fileId,
	position,
	duration,
	completed,
	audioStreamIndex,
	subtitleId,
	tx,
}: {
	profileId: string;
	fileId: string;
	position: number;
	duration: number;
	completed: boolean;
	audioStreamIndex?: number | null | undefined;
	subtitleId?: string | null | undefined;
	tx?: DatabaseTransaction | undefined;
}): Promise<void> {
	const now = new Date();
	const prepared = selectUpsertProgressPrepared(audioStreamIndex !== undefined, subtitleId !== undefined);

	await prepared(databaseFactory.getClient({ tx })).execute({
		id: Bun.randomUUIDv7(),
		profileId,
		fileId,
		position,
		duration,
		completed,
		audioStreamIndex: audioStreamIndex ?? null,
		subtitleId: subtitleId ?? null,
		createdAt: now,
		updatedAt: now,
	});
}

/** Bulk variant of {@link upsertProgress}: one statement writes every file's row. */
export async function upsertProgressBulk({
	profileId,
	rows,
	tx,
}: {
	profileId: string;
	rows: Array<{
		fileId: string;
		position: number;
		duration: number;
		completed: boolean;
		audioStreamIndex: number | null;
		subtitleId: string | null;
	}>;
	tx?: DatabaseTransaction | undefined;
}): Promise<void> {
	if (rows.length === 0) return;

	const now = new Date();
	await playbackProgress.upsert({
		values: rows.map((row) => ({
			id: Bun.randomUUIDv7(),
			profileId,
			mediaFileId: row.fileId,
			position: row.position,
			duration: row.duration,
			completed: row.completed,
			audioStreamIndex: row.audioStreamIndex,
			subtitleId: row.subtitleId,
			createdAt: now,
			updatedAt: now,
		})),
		target: [playbackProgress.table.profileId, playbackProgress.table.mediaFileId],
		set: {
			position: sql`excluded.position`,
			duration: sql`excluded.duration`,
			completed: sql`excluded.completed`,
			audioStreamIndex: sql`excluded.audio_stream_index`,
			subtitleId: sql`excluded.subtitle_id`,
			updatedAt: sql`excluded.updated_at`,
		},
		tx,
	});
}

export async function deleteProgress(profileId: string, fileId: string, tx?: DatabaseTransaction): Promise<void> {
	await databaseFactory
		.getClient({ tx })
		.delete(schema.playbackProgress)
		.where(and(eq(schema.playbackProgress.profileId, profileId), eq(schema.playbackProgress.mediaFileId, fileId)));
}

export async function deleteProgressForFiles(profileId: string, fileIds: readonly string[], tx?: DatabaseTransaction): Promise<void> {
	await databaseFactory
		.getClient({ tx })
		.delete(schema.playbackProgress)
		.where(and(eq(schema.playbackProgress.profileId, profileId), inArray(schema.playbackProgress.mediaFileId, [...fileIds])));
}

/** The profile's progress rows for the media files that belong to the title. */
function titleProgressFilter(profileId: string, metadataId: string, client: ReturnType<typeof databaseFactory.getClient>) {
	return and(
		eq(schema.playbackProgress.profileId, profileId),
		inArray(
			schema.playbackProgress.mediaFileId,
			client.select({ id: schema.mediaFiles.id }).from(schema.mediaFiles).where(eq(schema.mediaFiles.metadataId, metadataId)),
		),
	);
}

/** Hides a title from "Continue watching" without touching resume positions: it returns once any of its files is played again. */
export async function dismissContinueWatching(profileId: string, metadataId: string): Promise<void> {
	const client = databaseFactory.getClient();
	await client
		.update(schema.playbackProgress)
		.set({ dismissedAt: new Date() })
		.where(titleProgressFilter(profileId, metadataId, client));
}

export async function deleteMetadataProgress(profileId: string, metadataId: string, tx?: DatabaseTransaction): Promise<void> {
	const client = databaseFactory.getClient({ tx });
	await client.delete(schema.playbackProgress).where(titleProgressFilter(profileId, metadataId, client));
}
