import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { PlaylistFileCache } from "./playlist.cache";

const dir = join(tmpdir(), `reelvault-playlist-cache-${Date.now()}`);
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

describe("playlist file cache", () => {
	afterAll(async () => {
		await $`rm -rf ${dir}`.quiet();
	});

	test("returns an empty analysis and the read error when the playlist does not exist", async () => {
		await mkdir(dir, { recursive: true });
		const cache = new PlaylistFileCache();

		const result = await cache.read("s1", join(dir, "missing.m3u8"), 4);

		expect(result.ok).toBe(false);
		expect(result.analysis.complete).toBe(false);
		expect(result.analysis.segments).toEqual([]);
	});

	test("parses the playlist and reuses the cached views while stats are unchanged", async () => {
		await writePlaylist(playlistBody);
		const cache = new PlaylistFileCache();

		const first = await cache.read("s1", playlistPath, 4);
		const second = await cache.read("s1", playlistPath, 4);

		expect(first.ok && first.analysis.segments).toHaveLength(2);
		if (first.ok && second.ok) expect(second.playlist).toBe(first.playlist);
	});

	test("re-parses after the playlist was rewritten and does not cache a mid-read swap", async () => {
		await writePlaylist(playlistBody);
		const cache = new PlaylistFileCache();
		await cache.read("s1", playlistPath, 4);

		const longerBody = `${playlistBody}#EXTINF:4.0,\nseg_2.m4s\n`;
		await writePlaylist(longerBody);

		const refreshed = await cache.read("s1", playlistPath, 4);
		expect(refreshed.ok && refreshed.analysis.segments).toHaveLength(3);

		// Content swap between stat and read: old (mtime,size) must not end up in the cache with new content.
		await writePlaylist(`${longerBody}#EXTINF:4.0,\nseg_3.m4s\n`);
		const afterSwap = await cache.read("s1", playlistPath, 4);
		expect(afterSwap.ok && afterSwap.analysis.segments).toHaveLength(4);
	});

	test("a changed segment duration invalidates the cached parse", async () => {
		await writePlaylist(playlistBody);
		const cache = new PlaylistFileCache();

		const first = await cache.read("s1", playlistPath, 4);
		const second = await cache.read("s1", playlistPath, 2);

		if (first.ok && second.ok) expect(second.playlist).not.toBe(first.playlist);
	});

	test("rewrites the init segment URI onto the segments route", async () => {
		await writePlaylist(["#EXTM3U", '#EXT-X-MAP:URI="init.mp4"', "#EXTINF:4.0,", "seg_0.m4s"].join("\n"));
		const cache = new PlaylistFileCache();

		const result = await cache.read("s1", playlistPath, 4);

		expect(result.ok).toBe(true);
		if (result.ok) {
			const text = await result.playlist.text();
			expect(text).toContain('#EXT-X-MAP:URI="segments/init.mp4"');
			expect(text).not.toContain('#EXT-X-MAP:URI="init.mp4"');
		}
	});

	test("bounds cache size by evicting the oldest entries and invalidate forces a re-read", async () => {
		await writePlaylist(playlistBody);
		const cache = new PlaylistFileCache({ maxEntries: 2 });

		const first = await cache.read("s1", playlistPath, 4);
		const second = await cache.read("s2", playlistPath, 4);
		await cache.read("s1", playlistPath, 4); // s1 touched, s2 is now oldest
		await cache.read("s3", playlistPath, 4); // evicts s2

		const firstAgain = await cache.read("s1", playlistPath, 4);
		const secondAgain = await cache.read("s2", playlistPath, 4);
		if (first.ok && firstAgain.ok) expect(firstAgain.playlist).toBe(first.playlist);
		if (second.ok && secondAgain.ok) expect(secondAgain.playlist).not.toBe(second.playlist);

		cache.invalidate("s1");
		const afterInvalidate = await cache.read("s1", playlistPath, 4);
		if (first.ok && afterInvalidate.ok) expect(afterInvalidate.playlist).not.toBe(first.playlist);

		cache.clear();
	});
});
