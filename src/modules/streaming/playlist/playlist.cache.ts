import { FileUtils } from "@/utils/file.utils";
import { MemoryCache } from "@/utils/memory-cache";
import { parseHlsBuffer } from "../buffer/hls-buffer";
import type { HlsBufferAnalysis } from "../streaming.types";

interface PlaylistStats {
	mtimeMs: number;
	size: number;
}

export interface PlaylistFileReader {
	text(): Promise<string>;
}

/** All views derived from one read of a playlist file. */
export interface PlaylistViews {
	raw: string;
	playlist: Blob;
	analysis: HlsBufferAnalysis;
}

export type PlaylistFileReadResult = ({ ok: true } & PlaylistViews) | { ok: false; error: unknown; analysis: HlsBufferAnalysis };

interface PlaylistFileCacheDependencies {
	getStats: (path: string) => Promise<PlaylistStats | null>;
	readFile: (path: string) => PlaylistFileReader;
	maxEntries: number;
}

interface CacheEntry {
	stats: PlaylistStats;
	segmentDuration: number;
	views: PlaylistViews;
}

const DEFAULT_MAX_ENTRIES = 512;

/**
 * ffmpeg's `-hls_base_url` prefixes the segment URIs but not the fMP4 init
 * filename, so the raw manifest points at `init.mp4` — a URL the session API
 * does not serve. Remap it onto the segments route, which already handles the
 * init segment.
 */
function rewriteInitSegmentUri(playlist: string): string {
	return playlist.replace('URI="init.mp4"', 'URI="segments/init.mp4"');
}

/**
 * One stat + one read of the HLS playlist per (mtime, size) version, returning
 * the raw text, the rewritten Blob and the parsed buffer analysis together.
 * Freshness is the file's (mtimeMs, size) — unchanged stats never re-read the
 * file (playlists grow with the encode) — and entries are bounded/LRU-evicted
 * by MemoryCache. A file read failure is returned (not thrown) so both callers
 * can keep their own error policy.
 */
export class PlaylistFileCache {
	private readonly entries: MemoryCache<CacheEntry>;
	private readonly dependencies: PlaylistFileCacheDependencies;

	constructor(dependencies: Partial<PlaylistFileCacheDependencies> = {}) {
		this.dependencies = {
			getStats: (path) => FileUtils.getStats(path),
			readFile: (path) => FileUtils.get(path),
			maxEntries: DEFAULT_MAX_ENTRIES,
			...dependencies,
		};
		this.entries = new MemoryCache({ ttlMs: -1, maxSize: this.dependencies.maxEntries });
	}

	async read(sessionId: string, playlistPath: string, segmentDuration: number): Promise<PlaylistFileReadResult> {
		const stats = await this.dependencies.getStats(playlistPath);
		const cached = this.entries.get(sessionId);
		if (
			cached &&
			stats &&
			cached.segmentDuration === segmentDuration &&
			cached.stats.mtimeMs === stats.mtimeMs &&
			cached.stats.size === stats.size
		) {
			return { ok: true, ...cached.views };
		}

		let raw: string;
		try {
			raw = await this.dependencies.readFile(playlistPath).text();
		} catch (error) {
			return { ok: false, error, analysis: parseHlsBuffer("", segmentDuration) };
		}

		const views: PlaylistViews = {
			raw,
			playlist: new Blob([rewriteInitSegmentUri(raw)], { type: "application/x-mpegURL" }),
			analysis: parseHlsBuffer(raw, segmentDuration),
		};
		if (stats) this.entries.set(sessionId, { stats, segmentDuration, views });

		return { ok: true, ...views };
	}

	invalidate(sessionId: string): void {
		this.entries.delete(sessionId);
	}

	clear(): void {
		this.entries.clear();
	}
}

/** Shared instance so the playlist service and the streaming manager see one cache. */
export const playlistFileCache = new PlaylistFileCache();
