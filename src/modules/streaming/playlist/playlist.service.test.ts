import { describe, expect, test } from "bun:test";
import { PlaylistCache } from "./playlist.cache";
import { PlaylistService } from "./playlist.service";

function createService(
	options: { waitForPlaylistError?: Error; stats?: { mtimeMs: number; size: number } | null; text?: string; enoent?: boolean } = {},
) {
	let reads = 0;
	const cache = new PlaylistCache();
	const runtime = {
		keepAlive: () => {
			/* intentionally empty */
		},
		waitForPlaylist: () => {
			if (options.waitForPlaylistError) return Promise.reject(options.waitForPlaylistError);

			return Promise.resolve();
		},
		getFilePath: (_sessionId: string, file: string) => `/tmp/session-1/${file}`,
	};
	const getStats = async () => options.stats ?? null;
	const readFile = () => {
		if (options.enoent) {
			const error = new Error("no entry") as Error & { code?: string };
			error.code = "ENOENT";
			throw error;
		}

		reads += 1;

		return { text: async () => options.text ?? "#EXTM3U\nseg_0.m4s\n" };
	};

	return { service: new PlaylistService({ runtime, getStats, readFile, cache }), cache, reads: () => reads };
}

describe("playlist service", () => {
	test("wraps playlist wait failures in InternalError", async () => {
		const { service } = createService({ waitForPlaylistError: new Error("timeout waiting for playlist") });

		await expect(service.get("session-1")).rejects.toThrow("timeout waiting for playlist");
	});

	test("reads, rewrites and caches the playlist", async () => {
		const { service, cache, reads } = createService({ stats: { mtimeMs: 10, size: 20 } });

		const first = await service.get("session-1");
		expect(await first.text()).toContain("#EXTM3U");
		expect(reads()).toBe(1);

		// The second call with the same stats hits the cache — without reading the file.
		const second = await service.get("session-1");
		expect(second).toBe(first);
		expect(reads()).toBe(1);
		expect(cache.get("session-1", { mtimeMs: 10, size: 20 })).toBeInstanceOf(Blob);
	});

	test("re-reads when the playlist file was rewritten in the meantime", async () => {
		const { service, reads } = createService({ stats: null });

		await service.get("session-1");
		await service.get("session-1");

		expect(reads()).toBe(2);
	});

	test("remaps the init segment URI onto the segments route", async () => {
		const { service } = createService({
			text: ["#EXTM3U", "#EXT-X-VERSION:7", '#EXT-X-MAP:URI="init.mp4"', "#EXTINF:10.010000,", "segments/seg_0.m4s"].join("\n"),
		});

		const playlist = await service.get("session-1");
		const text = await playlist.text();

		expect(text).toContain('#EXT-X-MAP:URI="segments/init.mp4"');
		expect(text).not.toContain('#EXT-X-MAP:URI="init.mp4"');
		expect(text).toContain("segments/seg_0.m4s");
	});

	test("leaves the playlist untouched when the init URI is already mapped", async () => {
		const text = '#EXT-X-MAP:URI="segments/init.mp4"';
		const { service } = createService({ text });

		expect(await (await service.get("session-1")).text()).toBe(text);
	});

	test("maps ENOENT to a retryable request timeout", async () => {
		const { service } = createService({ enoent: true });

		await expect(service.get("session-1")).rejects.toThrow("seek in progress");
	});
});
