import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLAYLIST_FILE_NAME } from "@/modules/streaming/utils/segment-name.utils";
import { removeTree } from "@/utils/directory.utils";
import { PlaylistFileCache } from "./playlist.cache";
import { PlaylistService } from "./playlist.service";

const PLAYLIST = "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.0,\nseg_0.m4s\n";
const LONGER_PLAYLIST = `${PLAYLIST}#EXTINF:4.0,\nseg_9.m4s\n`;

let workDir = "";

beforeEach(async () => {
	workDir = await mkdtemp(join(tmpdir(), "reelvault-playlist-service-"));
});

afterEach(async () => {
	await removeTree(workDir);
});

/**
 * The real playlist cache reads the playlist from a temp directory. The transcode
 * runtime (the live ffmpeg process that writes the playlist) is the process
 * boundary, so the test supplies its methods.
 */
function createService(options: { waitForPlaylistError?: Error } = {}) {
	const runtime = {
		keepAlive: () => {
			/* intentionally empty */
		},
		waitForPlaylist: () => {
			if (options.waitForPlaylistError) return Promise.reject(options.waitForPlaylistError);

			return Promise.resolve();
		},
		getFilePath: (_sessionId: string, file: string) => join(workDir, file),
	};

	return new PlaylistService({ runtime, fileCache: new PlaylistFileCache() });
}

async function writePlaylist(body: string): Promise<void> {
	await writeFile(join(workDir, PLAYLIST_FILE_NAME), body);
}

describe("playlist service", () => {
	test("wraps playlist wait failures as an internal error with the playlist_unavailable code", async () => {
		const service = createService({ waitForPlaylistError: new Error("timeout waiting for playlist") });

		await expect(service.get("session-1")).rejects.toMatchObject({
			category: "internal",
			code: "stream.playlist_unavailable",
			message: "timeout waiting for playlist",
		});
	});

	test("returns the cached copy while the playlist file is unchanged", async () => {
		await writePlaylist(PLAYLIST);
		const service = createService();

		const first = await service.get("session-1");
		expect(await first.text()).toContain("#EXTM3U");

		expect(await service.get("session-1")).toBe(first);
	});

	test("re-reads once the playlist file has been rewritten", async () => {
		await writePlaylist(PLAYLIST);
		const service = createService();
		const first = await service.get("session-1");

		await writePlaylist(LONGER_PLAYLIST);
		const second = await service.get("session-1");

		expect(second).not.toBe(first);
		expect(await second.text()).toContain("seg_9.m4s");
	});

	test("remaps the init segment URI onto the segments route", async () => {
		await writePlaylist(
			["#EXTM3U", "#EXT-X-VERSION:7", '#EXT-X-MAP:URI="init.mp4"', "#EXTINF:10.010000,", "segments/seg_0.m4s"].join("\n"),
		);
		const service = createService();

		const text = await (await service.get("session-1")).text();

		expect(text).toContain('#EXT-X-MAP:URI="segments/init.mp4"');
		expect(text).not.toContain('#EXT-X-MAP:URI="init.mp4"');
		expect(text).toContain("segments/seg_0.m4s");
	});

	test("leaves the playlist untouched when the init URI is already mapped", async () => {
		const text = '#EXT-X-MAP:URI="segments/init.mp4"';
		await writePlaylist(text);
		const service = createService();

		expect(await (await service.get("session-1")).text()).toBe(text);
	});

	test("reports a rebuilding playlist while the file does not exist yet (ENOENT)", async () => {
		const service = createService();

		await expect(service.get("session-1")).rejects.toMatchObject({ category: "timeout", code: "stream.playlist_rebuilding" });
	});
});
