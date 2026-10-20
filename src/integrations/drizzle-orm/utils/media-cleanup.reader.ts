import { eq, inArray, type SQL } from "drizzle-orm";
import { serverConstants } from "@/config/server/server.constants";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import type { DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import { chunk } from "@/utils/array.utils";

export interface MediaCleanupData {
	artifactStorageKeys: string[];
	/** Null subtitles are dropped by library deletes, mapped through by the others. */
	subtitleFilePaths: Array<string | null>;
	subtitleIds: string[];
}

/**
 * Maps the cleanup rows shared by every media-file delete path. Callers that
 * only delete sidecar files (library removal) drop subtitles without a path;
 * the others map the null through so the cleanup step can decide.
 */
export function toMediaCleanupData(
	subtitles: ReadonlyArray<{ id: string; filePath: string | null }>,
	artifacts: ReadonlyArray<{ storageKey: string }>,
	{ filterNullSubtitlePaths = false }: { filterNullSubtitlePaths?: boolean } = {},
): MediaCleanupData {
	return {
		artifactStorageKeys: artifacts.map((artifact) => artifact.storageKey),
		subtitleFilePaths: filterNullSubtitlePaths
			? subtitles.flatMap((subtitle) => (subtitle.filePath ? [subtitle.filePath] : []))
			: subtitles.map((subtitle) => subtitle.filePath),
		subtitleIds: subtitles.map((subtitle) => subtitle.id),
	};
}

/**
 * Collects artifact keys and subtitle references of every media file matching
 * `where` (a predicate on `media_files`) — the joined query shared by metadata
 * and library deletes.
 */
export async function findMediaCleanupData({
	where,
	tx,
	filterNullSubtitlePaths = false,
}: {
	where: SQL;
	tx?: DatabaseTransaction | undefined;
	filterNullSubtitlePaths?: boolean;
}): Promise<MediaCleanupData> {
	const client = databaseFactory.getClient({ tx });
	const [artifacts, subtitles] = await Promise.all([
		client
			.select({ storageKey: schema.mediaArtifacts.storageKey })
			.from(schema.mediaArtifacts)
			.innerJoin(schema.mediaFiles, eq(schema.mediaFiles.id, schema.mediaArtifacts.mediaFileId))
			.where(where),
		client
			.select({ id: schema.subtitles.id, filePath: schema.subtitles.filePath })
			.from(schema.subtitles)
			.innerJoin(schema.mediaFiles, eq(schema.mediaFiles.id, schema.subtitles.mediaFileId))
			.where(where),
	]);

	return toMediaCleanupData(subtitles, artifacts, { filterNullSubtitlePaths });
}

type CleanupClient = ReturnType<typeof databaseFactory.getClient>;

function selectSubtitleRefsByMediaFileIds(client: CleanupClient, mediaFileIds: readonly string[]) {
	return client
		.select({ id: schema.subtitles.id, filePath: schema.subtitles.filePath })
		.from(schema.subtitles)
		.where(inArray(schema.subtitles.mediaFileId, [...mediaFileIds]));
}

function selectArtifactKeysByMediaFileIds(client: CleanupClient, mediaFileIds: readonly string[]) {
	return client
		.select({ storageKey: schema.mediaArtifacts.storageKey })
		.from(schema.mediaArtifacts)
		.where(inArray(schema.mediaArtifacts.mediaFileId, [...mediaFileIds]));
}

/**
 * Collects artifact keys and subtitle references for a list of media file ids,
 * chunked so one statement cannot exceed SQLite's bound-variable limit.
 */
export async function findCleanupDataForMediaFileIds(mediaFileIds: readonly string[], tx?: DatabaseTransaction): Promise<MediaCleanupData> {
	if (mediaFileIds.length === 0) return toMediaCleanupData([], []);

	const client = databaseFactory.getClient({ tx });
	const idChunks = chunk([...mediaFileIds], serverConstants.database.queryChunkSize);
	const [subtitleResults, artifactResults] = await Promise.all([
		Promise.all(idChunks.map((idChunk) => selectSubtitleRefsByMediaFileIds(client, idChunk))),
		Promise.all(idChunks.map((idChunk) => selectArtifactKeysByMediaFileIds(client, idChunk))),
	]);

	return toMediaCleanupData(subtitleResults.flat(), artifactResults.flat());
}
