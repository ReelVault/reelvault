import type { CreateMediaFile, FieldsQuery, UpdateMediaFile } from "@reelvault/sdk/common";
import { and, eq, inArray, isNull, ne, or, type SQL, sql } from "drizzle-orm";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import type { DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import { QueryUtils } from "@/integrations/drizzle-orm/query/parsing/query.parser";
import { forEachChunked } from "@/integrations/drizzle-orm/query/table-access/chunking.utils";
import { runInTransaction } from "@/integrations/drizzle-orm/query/transaction.utils";
import { hasEntry } from "@/utils/array.utils";
import { DomainError } from "@/utils/domain.errors";
import { findByLibraryAndPaths, findByPrimaryId, findCleanupData, findCleanupDataByMediaFileIds } from "./queries.reader";
import {
	mediaFileAudioStreams,
	mediaFileSubtitles,
	mediaFiles,
	mediaFileVideoStreams,
	streamingDurationCache,
	type TechnicalMediaFileData,
} from "./shared.utils";

export async function updateAndRead<F extends string>(mediaFileId: string, body: UpdateMediaFile, query?: FieldsQuery<F>) {
	const { fields } = QueryUtils.parseStandard(query);
	const { isDefault, ...values } = body;
	streamingDurationCache.delete(mediaFileId);
	await databaseFactory.transaction(async (tx) => {
		if (isDefault !== undefined) await setDefault(mediaFileId, isDefault, tx);

		const hasValues = hasEntry(values);
		if (hasValues) await mediaFiles.update({ primaryId: mediaFileId, values, tx });
	});

	return await findByPrimaryId({ primaryId: mediaFileId, fields });
}

export async function deleteAndGetCleanup(mediaFileId: string) {
	streamingDurationCache.delete(mediaFileId);

	return await databaseFactory.transaction(async (tx) => {
		const cleanup = await findCleanupData(mediaFileId, tx);
		await mediaFiles.delete({ primaryId: mediaFileId, tx });

		return cleanup;
	});
}

/**
 * Repoints a media file to new metadata/movie/episode and atomically decides
 * `isDefault` — a concurrent reassign to the same target must not leave two
 * defaults behind.
 */
export async function reassign({
	mediaFileId,
	metadataId,
	movieId,
	episodeId,
}: {
	mediaFileId: string;
	metadataId: string;
	movieId: string | null;
	episodeId: string | null;
}): Promise<void> {
	streamingDurationCache.delete(mediaFileId);
	await databaseFactory.transaction(async (tx) => {
		const existingDefault = await mediaFiles.selectFirst({
			where: movieId
				? and(eq(schema.mediaFiles.movieId, movieId), eq(schema.mediaFiles.isDefault, true), ne(schema.mediaFiles.id, mediaFileId))
				: and(
						eq(schema.mediaFiles.episodeId, episodeId ?? ""),
						eq(schema.mediaFiles.isDefault, true),
						ne(schema.mediaFiles.id, mediaFileId),
					),
			tx,
		});

		await mediaFiles.update({
			primaryId: mediaFileId,
			values: { metadataId, movieId, episodeId, isDefault: !existingDefault },
			tx,
		});
	});
}

export async function replaceTechnicalData({
	mediaFileId,
	data,
	size,
	sourceMtimeMs,
}: {
	mediaFileId: string;
	data: TechnicalMediaFileData;
	size: number;
	sourceMtimeMs: number;
}) {
	streamingDurationCache.delete(mediaFileId);
	await databaseFactory.transaction(async (tx) => {
		await mediaFiles.update({
			primaryId: mediaFileId,
			values: {
				formatName: data.formatName,
				duration: data.duration,
				size,
				sourceMtimeMs,
				bitRate: data.bitRate,
				source: data.source,
				edition: data.edition,
				qualityTag: data.qualityTag,
			},
			tx,
		});
		await replaceStreams(mediaFileId, data, tx);
		await replaceEmbeddedSubtitles(mediaFileId, data.subtitles ?? [], tx);
	});
}

export async function deleteByLibraryAndPathsAndGetCleanup(libraryId: string, filePaths: string[]) {
	streamingDurationCache.clear();

	return await databaseFactory.transaction(async (tx) => {
		const matchingMediaFiles = await findByLibraryAndPaths({ libraryId, filePaths, tx });
		const cleanup = await findCleanupDataByMediaFileIds(
			matchingMediaFiles.map((mediaFile) => mediaFile.id),
			tx,
		);
		await deleteByLibraryAndPaths({ libraryId, filePaths, tx });

		return {
			...cleanup,
			removedMediaFiles: matchingMediaFiles.map((mediaFile) => ({ id: mediaFile.id, filePath: mediaFile.filePath })),
		};
	});
}

/**
 * Pass an existing `tx` when creating many rows in a loop (e.g. during a library scan) so callers
 * can batch several inserts into a single commit instead of paying a transaction/fsync cost per row.
 * When no `tx` is given, behaves exactly as before and opens its own transaction.
 */
export async function createWithStreams(data: CreateMediaFile, tx?: DatabaseTransaction) {
	const { videoStreams, audioStreams, subtitles = [], ...mediaFileValues } = data;

	return await runInTransaction(tx, async (runTx) => {
		const [createdMediaFile] = await runTx.insert(schema.mediaFiles).values(mediaFileValues).onConflictDoNothing().returning();
		if (!createdMediaFile) {
			// Multi-episode files own several rows per path — fetch the row for
			// THIS target (episode id), not just any row with the same path.
			const existingMediaFile = await mediaFiles.selectFirst({
				where: data.episodeId
					? and(eq(schema.mediaFiles.filePath, data.filePath), eq(schema.mediaFiles.episodeId, data.episodeId))
					: and(eq(schema.mediaFiles.filePath, data.filePath), isNull(schema.mediaFiles.episodeId)),
				tx: runTx,
			});
			if (!existingMediaFile)
				throw new DomainError("internal", "Media file insert conflicted but no existing row was found", {
					code: "media_files.insert_conflict_row_missing",
				});

			return { mediaFile: existingMediaFile, created: false };
		}

		await Promise.all([
			mediaFileVideoStreams.insert({
				values: videoStreams.map((stream) => ({ ...stream, mediaFileId: createdMediaFile.id })),
				tx: runTx,
			}),
			mediaFileAudioStreams.insert({
				values: audioStreams.map((stream) => ({ ...stream, mediaFileId: createdMediaFile.id })),
				tx: runTx,
			}),
			mediaFileSubtitles.insert({
				values: subtitles.map((subtitle) => ({
					...subtitle,
					mediaFileId: createdMediaFile.id,
					type: "embedded" as const,
					filePath: null,
				})),
				tx: runTx,
			}),
		]);

		return { mediaFile: createdMediaFile, created: true };
	});
}

export async function replaceStreams(
	mediaFileId: string,
	streams: Pick<CreateMediaFile, "videoStreams" | "audioStreams">,
	tx: DatabaseTransaction,
) {
	await Promise.all([
		mediaFileVideoStreams.delete({ where: eq(schema.mediaFileVideoStreams.mediaFileId, mediaFileId), tx }),
		mediaFileAudioStreams.delete({ where: eq(schema.mediaFileAudioStreams.mediaFileId, mediaFileId), tx }),
	]);

	await Promise.all([
		mediaFileVideoStreams.insert({ values: streams.videoStreams.map((stream) => ({ ...stream, mediaFileId })), tx }),
		mediaFileAudioStreams.insert({ values: streams.audioStreams.map((stream) => ({ ...stream, mediaFileId })), tx }),
	]);
}

export async function replaceEmbeddedSubtitles(
	mediaFileId: string,
	subtitles: NonNullable<CreateMediaFile["subtitles"]>,
	tx: DatabaseTransaction,
): Promise<void> {
	await mediaFileSubtitles.delete({
		where: and(eq(schema.subtitles.mediaFileId, mediaFileId), eq(schema.subtitles.type, "embedded")),
		tx,
	});
	await mediaFileSubtitles.insert({
		values: subtitles.map((subtitle) => ({ ...subtitle, mediaFileId, type: "embedded" as const, filePath: null })),
		tx,
	});
}

export async function setDefault(mediaFileId: string, isDefault: boolean, tx: DatabaseTransaction): Promise<void> {
	const client = databaseFactory.getClient({ tx });
	const mediaFile = await client
		.select({ movieId: schema.mediaFiles.movieId, episodeId: schema.mediaFiles.episodeId })
		.from(schema.mediaFiles)
		.where(eq(mediaFiles.primaryKeyColumn, mediaFileId))
		.limit(1)
		.then((rows) => rows[0]);
	if (!mediaFile) return;

	let target: SQL | undefined;
	if (mediaFile.movieId) {
		target = eq(schema.mediaFiles.movieId, mediaFile.movieId);
	} else if (mediaFile.episodeId) {
		target = eq(schema.mediaFiles.episodeId, mediaFile.episodeId);
	}

	if (!target)
		throw new DomainError("internal", `Media file ${mediaFileId} has no movie or episode target`, { code: "media_files.target_missing" });

	if (!isDefault) {
		await client.update(schema.mediaFiles).set({ isDefault: false }).where(eq(mediaFiles.primaryKeyColumn, mediaFileId));

		return;
	}

	// One statement: the target row gets the flag, any other row of the same
	// movie/episode currently flagged default is cleared (the partial unique
	// index guarantees at most one such row).
	await client
		.update(schema.mediaFiles)
		.set({
			isDefault: sql`CASE WHEN ${mediaFiles.primaryKeyColumn} = ${mediaFileId} THEN 1 ELSE 0 END`,
		})
		.where(and(target, or(eq(schema.mediaFiles.isDefault, true), eq(mediaFiles.primaryKeyColumn, mediaFileId))));
}

export async function deleteByLibraryAndPaths({
	libraryId,
	filePaths,
	tx,
}: {
	libraryId: string;
	filePaths: string[];
	tx?: DatabaseTransaction | undefined;
}): Promise<void> {
	if (filePaths.length === 0) return;

	await forEachChunked(filePaths, (pathChunk) =>
		mediaFiles.delete({ where: and(eq(schema.mediaFiles.libraryId, libraryId), inArray(schema.mediaFiles.filePath, pathChunk)), tx }),
	);
}

/**
 * Delete media files by IDs. FK cascade handles dependent rows
 * (video/audio streams, subtitles, artifacts).
 */
export async function deleteByIds(ids: string[], tx?: DatabaseTransaction): Promise<number> {
	if (ids.length === 0) return 0;

	let deleted = 0;
	const client = databaseFactory.getClient({ tx });
	await forEachChunked(ids, async (idChunk) => {
		const result = await client.delete(schema.mediaFiles).where(inArray(schema.mediaFiles.id, idChunk));
		deleted += result.changes;
	});

	return deleted;
}
