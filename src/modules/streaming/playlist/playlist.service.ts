import { serverConfig } from "@/config/server/server.config";
import { streamingManager as streamingRuntimeService } from "@/modules/streaming/runtime/streaming.manager";
import { PLAYLIST_FILE_NAME } from "@/modules/streaming/utils/segment-name.utils";
import { DomainError, errorMessage, isMissingFile } from "@/utils/domain.errors";
import { createLogger } from "@/utils/logger.utils";
import { type PlaylistFileCache, playlistFileCache } from "./playlist.cache";

interface ServiceDependencies {
	runtime: Pick<typeof streamingRuntimeService, "keepAlive" | "waitForPlaylist" | "getFilePath">;
	fileCache: Pick<PlaylistFileCache, "read" | "invalidate">;
}

const defaultDependencies: ServiceDependencies = {
	runtime: streamingRuntimeService,
	fileCache: playlistFileCache,
};

export class PlaylistService {
	readonly serviceName = "PlaylistService";
	readonly logger = createLogger("PlaylistService");

	private readonly dependencies: ServiceDependencies;

	constructor(dependencies: ServiceDependencies = defaultDependencies) {
		this.dependencies = dependencies;
	}

	async get(sessionId: string, signal?: AbortSignal): Promise<Blob> {
		const { runtime, fileCache } = this.dependencies;
		runtime.keepAlive(sessionId);

		try {
			await runtime.waitForPlaylist(sessionId, undefined, signal);
		} catch (error) {
			if (error instanceof DomainError) throw error;

			throw new DomainError("internal", errorMessage(error), { code: "stream.playlist_unavailable" });
		}

		const playlistPath = runtime.getFilePath(sessionId, PLAYLIST_FILE_NAME);
		const result = await fileCache.read(sessionId, playlistPath, serverConfig.stream.hlsSegmentDurationSeconds);
		if (!result.ok) {
			if (isMissingFile(result.error)) {
				throw new DomainError("timeout", "Playlist is being rebuilt (seek in progress) — retry shortly", {
					code: "stream.playlist_rebuilding",
				});
			}

			throw result.error;
		}

		return result.playlist;
	}

	invalidate(sessionId: string): void {
		this.dependencies.fileCache.invalidate(sessionId);
	}
}

export const playlistService = new PlaylistService();
