import type { PluginMediaFile } from "@sdk/common";
import type { PluginMediaRevision } from "@sdk/plugin";
import { eq, isNotNull } from "drizzle-orm";
import { databaseFactory } from "@/database/database";
import { mediaRepository } from "@/database/repositories/media-files.repository";
import { schema } from "@/database/schema";
import { QueryFields } from "@/database/utils/fields";
import { groupBy } from "@/utils/array.utils";
import { BaseService } from "@/utils/base-service";
import { clamp } from "@/utils/math.utils";

const MAX_LIST_MEDIA_LIMIT = 10_000;

interface PluginEpisodeMediaFile {
	mediaFileId: string;
	filePath: string;
	fileName: string;
	durationSeconds: number;
	episodeId: string;
	seasonId: string;
	episodeNumber: number;
	title?: string | undefined;
}

class PluginMediaService extends BaseService {
	constructor() {
		super("PluginMediaService");
	}

	async get(mediaFileId: string): Promise<PluginMediaFile | null> {
		const mediaFile = await mediaRepository.findByPrimaryId({
			primaryId: mediaFileId,
			fields: QueryFields.parse({ fields: "id,metadataId,fileName,filePath,duration" }),
		});
		if (!mediaFile) return null;

		return {
			id: mediaFile.id,
			metadataId: mediaFile.metadataId,
			fileName: mediaFile.fileName,
			filePath: mediaFile.filePath,
			durationMs: mediaFile.duration === null ? undefined : mediaFile.duration * 1000,
			available: true,
		};
	}

	async getRevision(mediaFileId: string): Promise<PluginMediaRevision | null> {
		const mediaFile = await mediaRepository.findForPlaybackSession(mediaFileId);
		if (!mediaFile) return null;

		return {
			size: mediaFile.size,
			sourceMtimeMs: mediaFile.sourceMtimeMs,
			audioStreams: mediaFile.audioStreams.map((stream) => ({
				index: stream.index,
				channels: stream.channels,
				isDefault: stream.isDefault,
			})),
		};
	}

	async listEpisodeFilesBySeason(): Promise<Map<string, PluginEpisodeMediaFile[]>> {
		const rows = await databaseFactory
			.getClient()
			.select({
				mediaFileId: schema.mediaFiles.id,
				filePath: schema.mediaFiles.filePath,
				fileName: schema.mediaFiles.fileName,
				duration: schema.mediaFiles.duration,
				episodeId: schema.episodes.id,
				seasonId: schema.episodes.seasonId,
				episodeNumber: schema.episodes.episodeNumber,
				title: schema.episodes.title,
			})
			.from(schema.mediaFiles)
			.innerJoin(schema.episodes, eq(schema.mediaFiles.episodeId, schema.episodes.id))
			.where(isNotNull(schema.mediaFiles.episodeId));

		return groupBy(
			rows,
			(row) => row.seasonId,
			(row) => ({
				mediaFileId: row.mediaFileId,
				filePath: row.filePath,
				fileName: row.fileName,
				durationSeconds: row.duration ?? 0,
				episodeId: row.episodeId,
				seasonId: row.seasonId,
				episodeNumber: row.episodeNumber,
				title: row.title ?? undefined,
			}),
		);
	}

	async listAllMediaFiles(options?: { limit?: number; offset?: number }) {
		// Always bounded: an unbounded select would load the whole catalog into
		// memory for a plugin. Callers page with offset for the rest.
		const requestedLimit = options?.limit ?? MAX_LIST_MEDIA_LIMIT;
		const limit = clamp(requestedLimit, 1, MAX_LIST_MEDIA_LIMIT);
		const offset = options?.offset !== undefined ? Math.max(0, options.offset) : undefined;
		const rows = await databaseFactory
			.getClient()
			.select({
				mediaFileId: schema.mediaFiles.id,
				filePath: schema.mediaFiles.filePath,
				fileName: schema.mediaFiles.fileName,
				duration: schema.mediaFiles.duration,
				movieId: schema.mediaFiles.movieId,
				episodeId: schema.mediaFiles.episodeId,
				metadataTitle: schema.metadata.title,
			})
			.from(schema.mediaFiles)
			.leftJoin(schema.metadata, eq(schema.mediaFiles.metadataId, schema.metadata.id))
			.orderBy(schema.mediaFiles.id)
			.limit(limit)
			.offset(offset ?? 0);

		return rows.map((row) => ({
			mediaFileId: row.mediaFileId,
			filePath: row.filePath,
			fileName: row.fileName,
			durationSeconds: row.duration ?? 0,
			mediaType: row.movieId ? ("movie" as const) : ("episode" as const),
			title: row.metadataTitle ?? undefined,
			movieId: row.movieId,
			episodeId: row.episodeId,
		}));
	}
}

export const pluginMediaService = new PluginMediaService();
