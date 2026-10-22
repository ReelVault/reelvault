import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $, spawn } from "bun";
import { systemResourcesService } from "@/config/system-resources.service";
import { SessionStore } from "@/modules/streaming/runtime/session-state/session.store";
import { SessionReservationTracker } from "@/modules/streaming/runtime/session-state/session-reservation.tracker";
import { createMockPlaybackDecision } from "@/modules/streaming/streaming.helper";
import { stubMethod } from "../../../../tests/helpers/method-stub.helper";
import { PlaylistWaiter } from "./playlist.waiter";

const root = join(tmpdir(), `reelvault-playlist-waiter-${Date.now()}`);
/** The cushion window the waiter uses after the playlist appears. */
const CUSHION_MS = 2_000;
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
		// The cushion after the playlist appears is scaled by the host's speed, so it
		// is pinned here: the bound below is then a fixed number, not a race against
		// how fast the runner happens to be.
		const cushion = stubMethod(systemResourcesService, "scaledTimeoutMs", () => CUSHION_MS);
		const started = Date.now();

		try {
			await waiter.waitForPlaylist("s1", 60_000, () => Promise.resolve(false));
		} finally {
			cushion.restore();
		}

		// The playlist already carries the target segments, so the waiter must not
		// sit out the cushion window.
		expect(Date.now() - started).toBeLessThan(CUSHION_MS / 2);
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
