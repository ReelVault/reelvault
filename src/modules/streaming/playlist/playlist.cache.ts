import { MINUTE } from "@/server.constants";

export interface PlaylistStats {
	mtimeMs: number;
	size: number;
}

interface CacheEntry extends PlaylistStats {
	playlist: Blob;
	lastAccessAt: number;
}

interface CacheDependencies {
	now: () => number;
	maxEntries: number;
}

const DEFAULT_MAX_ENTRIES = 512;

/**
 * Cache for rewritten HLS playlists: keyed by the source file's (mtimeMs, size),
 * with LRU-style eviction of the oldest entries once the limit is exceeded.
 */
export class PlaylistCache {
	private readonly entries = new Map<string, CacheEntry>();
	private readonly dependencies: CacheDependencies;

	constructor(dependencies: Partial<CacheDependencies> = {}) {
		this.dependencies = { now: Date.now, maxEntries: DEFAULT_MAX_ENTRIES, ...dependencies };
	}

	get(sessionId: string, stats: PlaylistStats): Blob | undefined {
		const cached = this.entries.get(sessionId);
		if (!cached) return undefined;

		if (cached.mtimeMs !== stats.mtimeMs || cached.size !== stats.size) return undefined;

		cached.lastAccessAt = this.dependencies.now();
		// LRU touch: delete and re-set to move to the tail
		this.entries.delete(sessionId);
		this.entries.set(sessionId, cached);

		return cached.playlist;
	}

	set(sessionId: string, stats: PlaylistStats, playlist: Blob): void {
		const now = this.dependencies.now();
		this.entries.delete(sessionId);

		if (this.entries.size >= this.dependencies.maxEntries) {
			// Age sweep first, then evict least-recently-used until under the cap
			const cutoff = now - MINUTE;
			for (const [id, item] of this.entries) {
				if (item.lastAccessAt < cutoff) this.entries.delete(id);
			}

			while (this.entries.size >= this.dependencies.maxEntries) {
				const oldestId = this.entries.keys().next().value;
				if (oldestId === undefined) break;

				this.entries.delete(oldestId);
			}
		}

		this.entries.set(sessionId, { ...stats, playlist, lastAccessAt: now });
	}

	invalidate(sessionId: string): void {
		this.entries.delete(sessionId);
	}

	clear(): void {
		this.entries.clear();
	}
}

/** Shared instance so the streaming manager can invalidate on seek/release. */
export const playlistCache = new PlaylistCache();
