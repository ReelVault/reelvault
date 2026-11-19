import type { CreateMediaFile, FieldsQuery, UpdateMediaFile } from "@reelvault/sdk/common";
import { and, eq, inArray, isNull, ne, or, type SQL, sql } from "drizzle-orm";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import type { DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import { parseStandardQuery } from "@/integrations/drizzle-orm/query/parsing/query.parser";
import { forEachChunked } from "@/integrations/drizzle-orm/query/table-access/chunking.utils";
import { runInTransaction } from "@/integrations/drizzle-orm/query/transaction.utils";
import {
	applyMediaFileFlagDelta,
	applyMediaFileQualityDelta,
	applyMediaFileSizeDelta,
	applyMediaFileStats,
	type MediaFileStatsRow,
	mediaFileStatsColumns,
} from "@/repositories/media-stats.repository";
import { markLatestMediaCreatedAt, refreshLatestMediaCreatedAt } from "@/repositories/metadata/media-presence.writer";
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
	const { fields } = parseStandardQuery(query);
	const { isDefault, ...values } = body;
	await databaseFactory.transaction(async (tx) => {
		if (isDefault !== undefined) await setDefault(mediaFileId, isDefault, tx);

		const hasValues = hasEntry(values);
		let qualityChange: { libraryId: string; delta: number } | undefined;
		if (values.qualityTag !== undefined) {
			const client = databaseFactory.getClient({ tx });
			const existing = await client
				.select({ libraryId: schema.mediaFiles.libraryId, qualityTag: schema.mediaFiles.qualityTag })
				.from(schema.mediaFiles)
				.where(eq(mediaFiles.primaryKeyColumn, mediaFileId))
				.limit(1)
				.then((rows) => rows[0]);
			if (existing) {
				qualityChange = {
					libraryId: existing.libraryId,
					delta: Number(Boolean(values.qualityTag)) - Number(Boolean(existing.qualityTag)),
				};
			}
		}

		if (hasValues) await mediaFiles.update({ primaryId: mediaFileId, values, tx });
		if (qualityChange) await applyMediaFileQualityDelta(qualityChange.libraryId, qualityChange.delta, tx);
	});
	forgetStreamingDurations([mediaFileId]);

	return await findByPrimaryId({ primaryId: mediaFileId, fields });
}

/** Deletes the media file rows matching `where`, subtracts them from the library and catalog stats, and returns them. */
export async function removeMediaFileRows(
	where: SQL | undefined,
	tx: DatabaseTransaction,
): Promise<Array<MediaFileStatsRow & { id: string; metadataId: string }>> {
	// An undefined condition would select and delete the whole table.
	if (!where)
		throw new DomainError("internal", "Media file removal requires a condition", { code: "media_files.remove_condition_missing" });

	const rows = await tx
		.select({
			id: schema.mediaFiles.id,
			metadataId: schema.mediaFiles.metadataId,
			...mediaFileStatsColumns,
		})
		.from(schema.mediaFiles)
		.where(where);
	await tx.delete(schema.mediaFiles).where(where);
	await applyMediaFileStats(rows, -1, tx);

	return rows;
}

function forgetStreamingDurations(ids: readonly string[]): void {
	for (const id of ids) streamingDurationCache.delete(id);
}

export async function deleteAndGetCleanup(mediaFileId: string) {
	const cleanup = await databaseFactory.transaction(async (tx) => {
		const result = await findCleanupData(mediaFileId, tx);
		const removed = await removeMediaFileRows(eq(mediaFiles.primaryKeyColumn, mediaFileId), tx);
		await refreshLatestMediaCreatedAt(
			removed.map((row) => row.metadataId),
			tx,
		);

		return result;
	});
	forgetStreamingDurations([mediaFileId]);

	return cleanup;
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
	await databaseFactory.transaction(async (tx) => {
		const existingFile = await mediaFiles.selectFirst({ where: eq(mediaFiles.primaryKeyColumn, mediaFileId), tx });
		let defaultWhere: SQL | undefined;
		if (movieId) {
			defaultWhere = and(
				eq(schema.mediaFiles.movieId, movieId),
				eq(schema.mediaFiles.isDefault, true),
				ne(schema.mediaFiles.id, mediaFileId),
			);
		} else {
			defaultWhere = and(
				eq(schema.mediaFiles.episodeId, episodeId ?? ""),
				eq(schema.mediaFiles.isDefault, true),
				ne(schema.mediaFiles.id, mediaFileId),
			);
		}

		const existingDefault = await mediaFiles.selectFirst({ where: defaultWhere, tx });

		await mediaFiles.update({
			primaryId: mediaFileId,
			values: { metadataId, movieId, episodeId, isDefault: !existingDefault },
			tx,
		});

		if (existingFile) {
			if (existingFile.metadataId !== metadataId) await refreshLatestMediaCreatedAt([existingFile.metadataId], tx);
			await markLatestMediaCreatedAt(metadataId, existingFile.createdAt, tx);
			await applyMediaFileFlagDelta(
				existingFile.libraryId,
				Number(Boolean(movieId)) - Number(Boolean(existingFile.movieId)),
				Number(Boolean(episodeId)) - Number(Boolean(existingFile.episodeId)),
				tx,
			);
		}
	});
	forgetStreamingDurations([mediaFileId]);
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
	await databaseFactory.transaction(async (tx) => {
		const client = databaseFactory.getClient({ tx });
		const existing = await client
			.select({
				libraryId: schema.mediaFiles.libraryId,
				size: schema.mediaFiles.size,
				qualityTag: schema.mediaFiles.qualityTag,
			})
			.from(schema.mediaFiles)
			.where(eq(mediaFiles.primaryKeyColumn, mediaFileId))
			.limit(1)
			.then((rows) => rows[0]);

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
		if (existing) {
			await applyMediaFileSizeDelta(existing.libraryId, size - (existing.size ?? 0), tx);
			await applyMediaFileQualityDelta(existing.libraryId, Number(Boolean(data.qualityTag)) - Number(Boolean(existing.qualityTag)), tx);
		}
	});
	forgetStreamingDurations([mediaFileId]);
}

export async function deleteByLibraryAndPathsAndGetCleanup(libraryId: string, filePaths: string[]) {
	const { cleanup, matchingMediaFiles } = await databaseFactory.transaction(async (tx) => {
		const matches = await findByLibraryAndPaths({ libraryId, filePaths, tx });
		const found = await findCleanupDataByMediaFileIds(
			matches.map((mediaFile) => mediaFile.id),
			tx,
		);
		await deleteByLibraryAndPaths({ libraryId, filePaths, tx });

		return { cleanup: found, matchingMediaFiles: matches };
	});
	forgetStreamingDurations(matchingMediaFiles.map((mediaFile) => mediaFile.id));

	return {
		...cleanup,
		removedMediaFiles: matchingMediaFiles.map((mediaFile) => ({ id: mediaFile.id, filePath: mediaFile.filePath })),
	};
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
			let existingWhere: SQL | undefined;
			if (data.episodeId) {
				existingWhere = and(eq(schema.mediaFiles.filePath, data.filePath), eq(schema.mediaFiles.episodeId, data.episodeId));
			} else {
				existingWhere = and(eq(schema.mediaFiles.filePath, data.filePath), isNull(schema.mediaFiles.episodeId));
			}

			const existingMediaFile = await mediaFiles.selectFirst({ where: existingWhere, tx: runTx });
			if (!existingMediaFile)
				throw new DomainError("internal", "Media file insert conflicted but no existing row was found", {
					code: "media_files.insert_conflict_row_missing",
				});

			return { mediaFile: existingMediaFile, created: false };
		}

		await mediaFileVideoStreams.insert({
			values: videoStreams.map((stream) => ({ ...stream, mediaFileId: createdMediaFile.id })),
			tx: runTx,
		});
		await mediaFileAudioStreams.insert({
			values: audioStreams.map((stream) => ({ ...stream, mediaFileId: createdMediaFile.id })),
			tx: runTx,
		});
		await mediaFileSubtitles.insert({
			values: subtitles.map((subtitle) => ({
				...subtitle,
				mediaFileId: createdMediaFile.id,
				type: "embedded" as const,
				filePath: null,
			})),
			tx: runTx,
		});

		await markLatestMediaCreatedAt(createdMediaFile.metadataId, createdMediaFile.createdAt, runTx);
		await applyMediaFileStats([createdMediaFile], 1, runTx);

		return { mediaFile: createdMediaFile, created: true };
	});
}

export async function replaceStreams(
	mediaFileId: string,
	streams: Pick<CreateMediaFile, "videoStreams" | "audioStreams">,
	tx: DatabaseTransaction,
) {
	await mediaFileVideoStreams.delete({ where: eq(schema.mediaFileVideoStreams.mediaFileId, mediaFileId), tx });
	await mediaFileAudioStreams.delete({ where: eq(schema.mediaFileAudioStreams.mediaFileId, mediaFileId), tx });

	await mediaFileVideoStreams.insert({ values: streams.videoStreams.map((stream) => ({ ...stream, mediaFileId })), tx });
	await mediaFileAudioStreams.insert({ values: streams.audioStreams.map((stream) => ({ ...stream, mediaFileId })), tx });
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

	const removedIds = await runInTransaction(tx, async (runTx) => {
		const affectedMetadataIds = new Set<string>();
		const ids: string[] = [];
		await forEachChunked(filePaths, async (pathChunk) => {
			const removed = await removeMediaFileRows(
				and(eq(schema.mediaFiles.libraryId, libraryId), inArray(schema.mediaFiles.filePath, pathChunk)),
				runTx,
			);
			for (const row of removed) {
				affectedMetadataIds.add(row.metadataId);
				ids.push(row.id);
			}
		});
		await refreshLatestMediaCreatedAt([...affectedMetadataIds], runTx);

		return ids;
	});
	forgetStreamingDurations(removedIds);
}

/**
 * Delete media files by IDs. FK cascade handles dependent rows
 * (video/audio streams, subtitles, artifacts).
 */
export async function deleteByIds(ids: string[], tx?: DatabaseTransaction): Promise<number> {
	if (ids.length === 0) return 0;

	const deleted = await runInTransaction(tx, async (runTx) => {
		let count = 0;
		const affectedMetadataIds = new Set<string>();
		await forEachChunked(ids, async (idChunk) => {
			const removed = await removeMediaFileRows(inArray(schema.mediaFiles.id, idChunk), runTx);
			for (const row of removed) affectedMetadataIds.add(row.metadataId);
			count += removed.length;
		});
		await refreshLatestMediaCreatedAt([...affectedMetadataIds], runTx);

		return count;
	});
	forgetStreamingDurations(ids);

	return deleted;
}
