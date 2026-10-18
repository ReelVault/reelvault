import type { PluginMediaFile } from "@reelvault/sdk/common";
import type { PluginMediaRevision } from "@reelvault/sdk/plugin";
import { pluginMediaData } from "@/app/plugins/plugin-data.service";
import { QueryFields } from "@/integrations/drizzle-orm/query/parsing/fields.parser";
import { groupBy } from "@/utils/array.utils";
import { createLogger } from "@/utils/logger.utils";
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

class PluginMediaService {
	readonly serviceName = "PluginMediaService";
	readonly logger = createLogger("PluginMediaService");

	async get(mediaFileId: string): Promise<PluginMediaFile | null> {
		const mediaFile = await pluginMediaData.findByPrimaryId({
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
		const mediaFile = await pluginMediaData.findForPlaybackSession(mediaFileId);
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
		const rows = await pluginMediaData.findEpisodeFileRows();

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
		const offset = options?.offset !== undefined ? Math.max(0, options.offset) : 0;
		const rows = await pluginMediaData.findFileRowsPage({ limit, offset });

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
