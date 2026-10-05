import { eq, type SQL } from "drizzle-orm";
import { databaseFactory } from "@/database/database";
import { schema } from "@/database/schema";
import type { DatabaseTransaction } from "@/database/types";

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
