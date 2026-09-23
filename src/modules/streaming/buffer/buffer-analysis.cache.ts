import { FileUtils } from "@/utils/file.utils";
import type { HlsBufferAnalysis } from "../streaming.types";
import { getBufferedSeekStart, parseHlsBuffer } from "./hls-buffer";

interface CacheEntry {
	modifiedAt: number;
	size: number;
	analysis: HlsBufferAnalysis;
}

const DEFAULT_MAX_ENTRIES = 256;

/**
 * Re-parsing the HLS playlist on every poll would be wasteful — this caches
 * the analysis and only re-parses when the playlist's mtime/size changed.
 */
export class BufferAnalysisCache {
	private readonly cache = new Map<string, CacheEntry>();
	private readonly segmentDuration: number;
	private readonly getPlaylistPath: (sessionId: string) => string;
	private readonly maxEntries: number;

	constructor(segmentDuration: number, getPlaylistPath: (sessionId: string) => string, maxEntries = DEFAULT_MAX_ENTRIES) {
		this.segmentDuration = segmentDuration;
		this.getPlaylistPath = getPlaylistPath;
		this.maxEntries = maxEntries;
	}

	async read(sessionId: string): Promise<HlsBufferAnalysis> {
		const playlistPath = this.getPlaylistPath(sessionId);

		// Stat first: when (mtime, size) is unchanged the cached analysis is still
		// valid, so the playlist never has to be read or parsed. Reading first would
		// pay a full file read (playlists grow with the encode) on every seek and
		// every admin/diagnostics buffer poll even when the cache hits.
		const stats = await FileUtils.getStats(playlistPath);
		const cached = this.cache.get(sessionId);

		if (cached && stats && cached.modifiedAt === stats.mtimeMs && cached.size === stats.size) {
			this.cache.delete(sessionId);
			this.cache.set(sessionId, cached);

			return cached.analysis;
		}

		let text: string;
		try {
			text = await FileUtils.get(playlistPath).text();
		} catch {
			return parseHlsBuffer("", this.segmentDuration);
		}

		const analysis = parseHlsBuffer(text, this.segmentDuration);
		if (stats) {
			this.cache.delete(sessionId);
			if (this.cache.size >= this.maxEntries) {
				const oldestKey = this.cache.keys().next().value;
				if (oldestKey !== undefined) this.cache.delete(oldestKey);
			}

			this.cache.set(sessionId, { modifiedAt: stats.mtimeMs, size: stats.size, analysis });
		}

		return analysis;
	}

	async getBufferedSeekStart(sessionId: string, position: number): Promise<number | null> {
		const analysis = await this.read(sessionId);

		return getBufferedSeekStart(analysis, position, this.segmentDuration);
	}

	invalidate(sessionId: string): void {
		this.cache.delete(sessionId);
	}

	clear(): void {
		this.cache.clear();
	}
}
