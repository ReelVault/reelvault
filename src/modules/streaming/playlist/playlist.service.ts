import { BaseService } from "@/utils/base-service";
import { errorMessage, InternalError, isMissingFile, RequestTimeoutError } from "@/utils/errors";
import { FileUtils } from "@/utils/file.utils";
import { streamingService as streamingRuntimeService } from "../runtime/streaming.manager";
import { type PlaylistCache, type PlaylistStats, playlistCache } from "./playlist.cache";

export interface PlaylistFileReader {
	text(): Promise<string>;
}

interface ServiceDependencies {
	runtime: Pick<typeof streamingRuntimeService, "keepAlive" | "waitForPlaylist" | "getFilePath">;
	getStats: (path: string) => Promise<PlaylistStats | null>;
	readFile: (path: string) => PlaylistFileReader;
	cache: PlaylistCache;
}

const defaultDependencies: ServiceDependencies = {
	runtime: streamingRuntimeService,
	getStats: (path) => FileUtils.getStats(path),
	readFile: (path) => FileUtils.get(path),
	cache: playlistCache,
};

/**
 * ffmpeg's `-hls_base_url` prefixes the segment URIs but not the fMP4 init
 * filename, so the raw manifest points at `init.mp4` — a URL the session API
 * does not serve. Remap it onto the segments route, which already handles the
 * init segment.
 */
function rewriteInitSegmentUri(playlist: string): string {
	return playlist.replace('URI="init.mp4"', 'URI="segments/init.mp4"');
}

export class PlaylistService extends BaseService {
	private readonly dependencies: ServiceDependencies;

	constructor(dependencies: ServiceDependencies = defaultDependencies) {
		super("PlaylistService");
		this.dependencies = dependencies;
	}

	async get(sessionId: string, signal?: AbortSignal): Promise<Blob> {
		const { runtime, getStats, readFile, cache } = this.dependencies;
		runtime.keepAlive(sessionId);

		try {
			await runtime.waitForPlaylist(sessionId, undefined, signal);
		} catch (error) {
			throw new InternalError(errorMessage(error));
		}

		const playlistPath = runtime.getFilePath(sessionId, "playlist.m3u8");
		const stats = await getStats(playlistPath);

		if (stats) {
			const cached = cache.get(sessionId, stats);
			if (cached) return cached;
		}

		try {
			const text = await readFile(playlistPath).text();
			const playlist = new Blob([rewriteInitSegmentUri(text)], { type: "application/x-mpegURL" });
			if (stats) cache.set(sessionId, stats, playlist);

			return playlist;
		} catch (error) {
			if (isMissingFile(error)) {
				throw new RequestTimeoutError("Playlist is being rebuilt (seek in progress) — retry shortly");
			}

			throw error;
		}
	}

	invalidate(sessionId: string): void {
		this.dependencies.cache.invalidate(sessionId);
	}
}

export const playlistService = new PlaylistService();
