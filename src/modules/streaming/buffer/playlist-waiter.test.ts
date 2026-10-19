import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $, spawn } from "bun";
import { SessionStore } from "@/modules/streaming/runtime/session-state/session.store";
import { SessionReservationTracker } from "@/modules/streaming/runtime/session-state/session-reservation.tracker";
import { createMockPlaybackDecision } from "@/modules/streaming/streaming.helper";
import { PlaylistWaiter } from "./playlist.waiter";

const root = join(tmpdir(), `reelvault-playlist-waiter-${Date.now()}`);
const spawnedProcs: Bun.Subprocess[] = [];

function fakeProcess(exitCode: number | null): Bun.Subprocess {
	const proc = exitCode === null ? spawn(["sleep", "10"]) : spawn(["sh", "-c", `exit ${exitCode}`]);
	spawnedProcs.push(proc);

	return proc;
}

// Each case gets its own directory so the "playlist exists" state is isolated.
function createWaiter(caseName: string, options: { session?: { exitCode: number | null } | null; pending?: boolean } = {}) {
	const dir = join(root, caseName);
	const store = new SessionStore();
	const reservations = new SessionReservationTracker(store, 5);
	if (options.session) {
		store.register({
			id: "s1",
			mediaFileId: "file-1",
			profileId: "profile-1",
			decision: createMockPlaybackDecision({ mode: "direct-stream" }),
			inputPath: "/media/f.mkv",
			tempDir: dir,
		});
		store.attachProcess("s1", fakeProcess(options.session.exitCode), 0);
	}

	if (options.pending) reservations.reserve("s1");

	const waiter = new PlaylistWaiter(store, reservations, (_sessionId, fileName) => join(dir, fileName), 4);

	return { waiter, dir };
}

describe("playlist waiter", () => {
	afterAll(async () => {
		for (const p of spawnedProcs) {
			try {
				p.kill();
			} catch {
				// intentionally empty
			}
		}

		await $`rm -rf ${root}`.quiet();
	});

	test("finishes fast when the playlist already has the target segments", async () => {
		const { waiter, dir } = createWaiter("complete", { session: { exitCode: null } });
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "playlist.m3u8"), "#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXTINF:4.0,\nseg_0.m4s\n#EXTINF:4.0,\nseg_1.m4s\n");
		const started = Date.now();

		await waiter.waitForPlaylist("s1", 5_000, () => Promise.resolve(false));

		// Generous margin: must return right after the first poll, never wait
		// out the target window.
		expect(Date.now() - started).toBeLessThan(2_500);
	});

	test("throws when the playlist is missing and no session or reservation exists", async () => {
		const { waiter } = createWaiter("no-session");

		await expect(waiter.waitForPlaylist("s1", 50, () => Promise.resolve(false))).rejects.toMatchObject({
			category: "internal",
			code: "streaming_process_not_started",
		});
	});

	test("throws when the process exits before creating the playlist", async () => {
		const { waiter } = createWaiter("dead-process", { session: { exitCode: 1 } });

		await expect(waiter.waitForPlaylist("s1", 50, () => Promise.resolve(false))).rejects.toMatchObject({
			category: "internal",
			code: "streaming_process_exited",
		});
	});

	test("waits for the playlist of a pending reservation and surfaces the generation timeout", async () => {
		const { waiter } = createWaiter("pending", { pending: true });
		const started = Date.now();

		const failure: unknown = await waiter.waitForPlaylist("s1", 60, async () => false).catch((error: unknown) => error);

		expect(failure).toMatchObject({ category: "timeout", code: "playlist_generation_timeout" });
		expect(Date.now() - started).toBeGreaterThanOrEqual(50);
	});
});
