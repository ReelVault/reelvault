import { serverConfig } from "@/server.config";
import { BaseService } from "@/utils/base-service";
import { errorMessage, InternalError, isMissingFile, RequestTimeoutError } from "@/utils/errors";
import { streamingManager as streamingRuntimeService } from "../runtime/streaming.manager";
import { PLAYLIST_FILE_NAME } from "../utils/segment-name.utils";
import { type PlaylistFileCache, playlistFileCache } from "./playlist.cache";

interface ServiceDependencies {
	runtime: Pick<typeof streamingRuntimeService, "keepAlive" | "waitForPlaylist" | "getFilePath">;
	fileCache: Pick<PlaylistFileCache, "read" | "invalidate">;
}

const defaultDependencies: ServiceDependencies = {
	runtime: streamingRuntimeService,
	fileCache: playlistFileCache,
};

export class PlaylistService extends BaseService {
	private readonly dependencies: ServiceDependencies;

	constructor(dependencies: ServiceDependencies = defaultDependencies) {
		super("PlaylistService");
		this.dependencies = dependencies;
	}

	async get(sessionId: string, signal?: AbortSignal): Promise<Blob> {
		const { runtime, fileCache } = this.dependencies;
		runtime.keepAlive(sessionId);

		try {
			await runtime.waitForPlaylist(sessionId, undefined, signal);
		} catch (error) {
			throw new InternalError(errorMessage(error));
		}

		const playlistPath = runtime.getFilePath(sessionId, PLAYLIST_FILE_NAME);
		const result = await fileCache.read(sessionId, playlistPath, serverConfig.stream.hlsSegmentDurationSeconds);
		if (!result.ok) {
			if (isMissingFile(result.error)) {
				throw new RequestTimeoutError("Playlist is being rebuilt (seek in progress) — retry shortly");
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
