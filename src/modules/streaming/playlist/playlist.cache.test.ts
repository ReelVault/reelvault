import { describe, expect, test } from "bun:test";
import { PlaylistCache } from "./playlist.cache";

const stats = { mtimeMs: 100, size: 200 };
const playlist = new Blob(["#EXTM3U"], { type: "application/x-mpegURL" });

describe("playlist cache", () => {
	test("returns the cached playlist while file stats are unchanged", () => {
		const cache = new PlaylistCache();
		cache.set("session-1", stats, playlist);

		expect(cache.get("session-1", stats)).toBe(playlist);
	});

	test("misses when the file was rewritten (mtime or size changed)", () => {
		const cache = new PlaylistCache();
		cache.set("session-1", stats, playlist);

		expect(cache.get("session-1", { mtimeMs: 101, size: 200 })).toBeUndefined();
		expect(cache.get("session-1", { mtimeMs: 100, size: 201 })).toBeUndefined();
		expect(cache.get("session-2", stats)).toBeUndefined();
	});

	test("evicts the least-recently-used entry when full (bounded cache)", () => {
		let now = 1_000;
		const cache = new PlaylistCache({ now: () => now, maxEntries: 2 });

		cache.set("session-1", stats, playlist);
		now = 20_000;
		cache.set("session-2", stats, playlist);
		now = 30_000;
		cache.get("session-1", stats); // session-1 becomes the most recently used
		now = 40_000;
		// Full: session-2 (lastAccess 20 000) is the LRU and is evicted.
		cache.set("session-3", stats, playlist);

		expect(cache.get("session-2", stats)).toBeUndefined();
		expect(cache.get("session-1", stats)).toBe(playlist);
		expect(cache.get("session-3", stats)).toBe(playlist);
	});

	test("sweeps entries idle for over a minute before evicting", () => {
		let now = 1_000;
		const cache = new PlaylistCache({ now: () => now, maxEntries: 2 });

		cache.set("session-1", stats, playlist);
		now = 200_000; // more than MINUTE later
		cache.set("session-2", stats, playlist);
		now = 210_000;
		cache.set("session-3", stats, playlist); // session-1 is stale → swept, no LRU eviction

		expect(cache.get("session-1", stats)).toBeUndefined();
		expect(cache.get("session-2", stats)).toBe(playlist);
		expect(cache.get("session-3", stats)).toBe(playlist);
	});

	test("invalidate drops the entry", () => {
		const cache = new PlaylistCache();
		cache.set("session-1", stats, playlist);
		cache.invalidate("session-1");

		expect(cache.get("session-1", stats)).toBeUndefined();
	});
});
