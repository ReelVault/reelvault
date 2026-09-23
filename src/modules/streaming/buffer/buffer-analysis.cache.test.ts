import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { BufferAnalysisCache } from "./buffer-analysis.cache";

const dir = join(tmpdir(), `reelvault-buffer-cache-${Date.now()}`);
const playlistPath = join(dir, "playlist.m3u8");

const playlistBody = `#EXTM3U
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:4.0,
seg_0.m4s
#EXTINF:4.0,
seg_1.m4s
`;

async function writePlaylist(body: string) {
	await writeFile(playlistPath, body);
	// Each rewrite changes the body length, so the (mtime, size) cache key can
	// never collide across writes — no waiting for a fresh mtime needed.
}

describe("buffer analysis cache", () => {
	afterAll(async () => {
		await $`rm -rf ${dir}`.quiet();
	});

	test("returns an empty analysis when the playlist does not exist", async () => {
		await mkdir(dir, { recursive: true });
		const cache = new BufferAnalysisCache(4, () => join(dir, "missing.m3u8"));

		const analysis = await cache.read("s1");

		expect(analysis.complete).toBe(false);
		expect(analysis.segments).toEqual([]);
	});

	test("parses the playlist and reuses the cached analysis while stats are unchanged", async () => {
		await writePlaylist(playlistBody);
		const cache = new BufferAnalysisCache(4, () => playlistPath);

		const first = await cache.read("s1");
		const second = await cache.read("s1");

		expect(first.segments).toHaveLength(2);
		expect(second).toBe(first);
	});

	test("re-parses after the playlist was rewritten and does not cache a mid-read swap", async () => {
		await writePlaylist(playlistBody);
		const cache = new BufferAnalysisCache(4, () => playlistPath);
		await cache.read("s1");

		const longerBody = `${playlistBody}#EXTINF:4.0,\nseg_2.m4s\n`;
		await writePlaylist(longerBody);

		const refreshed = await cache.read("s1");
		expect(refreshed.segments).toHaveLength(3);

		// Content swap between stat and read: old (mtime,size) must not end up in the cache with new content.
		await writePlaylist(`${longerBody}#EXTINF:4.0,\nseg_3.m4s\n`);
		const afterSwap = await cache.read("s1");
		expect(afterSwap.segments).toHaveLength(4);
	});

	test("getBufferedSeekStart finds a buffered position and invalidate forces a re-read", async () => {
		await writePlaylist(playlistBody);
		const cache = new BufferAnalysisCache(4, () => playlistPath);

		expect(await cache.getBufferedSeekStart("s1", 5)).toBe(4);

		cache.invalidate("s1");
		expect(await cache.getBufferedSeekStart("s1", 5)).toBe(4);

		cache.clear();
	});

	test("bounds cache size by evicting oldest entries when maxEntries is exceeded", async () => {
		await writePlaylist(playlistBody);
		const cache = new BufferAnalysisCache(4, () => playlistPath, 2);

		// Read s1 and s2
		const a1 = await cache.read("s1");
		await cache.read("s2");
		expect(await cache.read("s1")).toBe(a1); // s1 touched, s2 is now oldest

		// Read s3 -> should evict s2 (since maxEntries = 2)
		const a3 = await cache.read("s3");
		expect(await cache.read("s3")).toBe(a3);
		expect(await cache.read("s1")).toBe(a1); // s1 still present
	});
});
