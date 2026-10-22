import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { PlaylistFileCache, type PlaylistFileReadResult } from "./playlist.cache";

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
	// Each describe block removes the directory in its afterAll, so every write recreates it.
	await mkdir(dir, { recursive: true });
	await writeFile(playlistPath, body);
	// Each rewrite changes the body length, so the (mtime, size) cache key can
	// never collide across writes — no waiting for a fresh mtime needed.
}

/** A failed read fails the test here, so the assertions after it cannot be skipped. */
function expectOk(result: PlaylistFileReadResult): Extract<PlaylistFileReadResult, { ok: true }> {
	if (!result.ok) throw new Error("expected the playlist read to succeed");

	return result;
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

		const first = expectOk(await cache.read("s1", playlistPath, 4));
		const second = expectOk(await cache.read("s1", playlistPath, 4));

		expect(first.analysis.segments).toHaveLength(2);
		expect(second.playlist).toBe(first.playlist);
	});

	test("re-parses after each rewrite of the playlist", async () => {
		await writePlaylist(playlistBody);
		const cache = new PlaylistFileCache();
		await cache.read("s1", playlistPath, 4);

		const longerBody = `${playlistBody}#EXTINF:4.0,\nseg_2.m4s\n`;
		await writePlaylist(longerBody);
		const refreshed = expectOk(await cache.read("s1", playlistPath, 4));
		expect(refreshed.analysis.segments).toHaveLength(3);

		await writePlaylist(`${longerBody}#EXTINF:4.0,\nseg_3.m4s\n`);
		const afterNextRewrite = expectOk(await cache.read("s1", playlistPath, 4));
		expect(afterNextRewrite.analysis.segments).toHaveLength(4);
	});

	test("a changed segment duration invalidates the cached parse", async () => {
		await writePlaylist(playlistBody);
		const cache = new PlaylistFileCache();

		const first = expectOk(await cache.read("s1", playlistPath, 4));
		const second = expectOk(await cache.read("s1", playlistPath, 2));

		expect(second.playlist).not.toBe(first.playlist);
	});

	test("rewrites the init segment URI onto the segments route", async () => {
		await writePlaylist(["#EXTM3U", '#EXT-X-MAP:URI="init.mp4"', "#EXTINF:4.0,", "seg_0.m4s"].join("\n"));
		const cache = new PlaylistFileCache();

		const result = expectOk(await cache.read("s1", playlistPath, 4));
		const text = await result.playlist.text();

		expect(text).toContain('#EXT-X-MAP:URI="segments/init.mp4"');
		expect(text).not.toContain('#EXT-X-MAP:URI="init.mp4"');
	});

	test("leaves the playlist untouched when the init URI is already mapped", async () => {
		const text = '#EXT-X-MAP:URI="segments/init.mp4"';
		await writePlaylist(text);
		const cache = new PlaylistFileCache();

		const result = expectOk(await cache.read("s1", playlistPath, 4));

		expect(await result.playlist.text()).toBe(text);
	});
});

describe("playlist file cache eviction and invalidation", () => {
	test("evicts the least recently used session once maxEntries is reached", async () => {
		await writePlaylist(playlistBody);
		const cache = new PlaylistFileCache({ maxEntries: 2 });
		const s1 = expectOk(await cache.read("s1", playlistPath, 4));
		const s2 = expectOk(await cache.read("s2", playlistPath, 4));
		await cache.read("s1", playlistPath, 4); // s1 is now the most recently used
		await cache.read("s3", playlistPath, 4); // evicts s2, the least recently used

		const s1Again = expectOk(await cache.read("s1", playlistPath, 4));
		const s2Again = expectOk(await cache.read("s2", playlistPath, 4));

		expect(s1Again.playlist).toBe(s1.playlist);
		expect(s2Again.playlist).not.toBe(s2.playlist);
	});

	test("invalidate forces the next read of a session to re-parse", async () => {
		await writePlaylist(playlistBody);
		const cache = new PlaylistFileCache();
		const first = expectOk(await cache.read("s1", playlistPath, 4));

		cache.invalidate("s1");
		const afterInvalidate = expectOk(await cache.read("s1", playlistPath, 4));

		expect(afterInvalidate.playlist).not.toBe(first.playlist);
	});
});
