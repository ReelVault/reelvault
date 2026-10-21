import { afterAll, describe, expect, test } from "bun:test";
import { readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscodeConfig } from "@reelvault/sdk/common";
import { $, spawn } from "bun";
import { SessionStore } from "@/modules/streaming/runtime/session-state/session.store";
import { SessionReservationTracker } from "@/modules/streaming/runtime/session-state/session-reservation.tracker";
import { createMockPlaybackDecision } from "@/modules/streaming/streaming.helper";
import { ProcessManager } from "./process.manager";

const root = join(tmpdir(), `reelvault-process-manager-${Date.now()}`);

const config: TranscodeConfig = {
	maxSessions: 1,
	inactivityTimeout: 60_000,
	cleanupInterval: 60_000,
	tempRootDir: root,
	hlsSegmentDuration: 4,
};

function createStore() {
	return new SessionStore();
}

describe("process manager", () => {
	afterAll(async () => {
		await $`rm -rf ${root}`.quiet();
	});

	test("startSession rejects at the global session limit before touching processes", async () => {
		const store = createStore();
		store.register({
			id: "occupied",
			mediaFileId: "file-0",
			profileId: "profile-1",
			decision: createMockPlaybackDecision({ mode: "transcode" }),
			inputPath: "/media/f.mkv",
			tempDir: join(root, "occupied"),
		});
		store.attachProcess("occupied", spawn(["true"]), 0);
		const manager = new ProcessManager(config, store, new SessionReservationTracker(store, 1));
		const session = store.register({
			id: "s1",
			mediaFileId: "file-1",
			profileId: "profile-1",
			decision: createMockPlaybackDecision({ mode: "transcode" }),
			inputPath: "/media/f.mkv",
			tempDir: join(root, "s1"),
		});

		await expect(
			manager.startSession({
				sessionId: "s1",
				session,
				inputPath: "/media/f.mkv",
				decision: createMockPlaybackDecision({ mode: "transcode" }),
				startTime: 0,
				timelineStart: 0,
			}),
		).rejects.toMatchObject({ category: "too_many_requests", code: "stream.limit_reached" });
	});

	test("ensureTempDirectory replaces leftover session files with an empty directory", async () => {
		const store = createStore();
		const manager = new ProcessManager(config, store, new SessionReservationTracker(store, 1));
		const tempDir = join(root, "session-1");
		await manager.ensureTempDirectory(tempDir);
		await writeFile(join(tempDir, "stale-seg_0.m4s"), "old");
		await manager.ensureTempDirectory(tempDir);

		expect(await readdir(tempDir)).toEqual([]);
	});

	test("removeTempDirectory deletes an existing directory and tolerates a missing one", async () => {
		const store = createStore();
		const manager = new ProcessManager(config, store, new SessionReservationTracker(store, 1));
		const tempDir = join(root, "session-2");
		await manager.ensureTempDirectory(tempDir);

		await manager.removeTempDirectory(tempDir);
		await expect(stat(tempDir)).rejects.toThrow();
		await expect(manager.removeTempDirectory(tempDir)).resolves.toBeUndefined();
	});

	test("retryWithSoftwareEncoder is a no-op success when the session already fell back", async () => {
		const store = createStore();
		const manager = new ProcessManager(config, store, new SessionReservationTracker(store, 1));
		const softwareFallbackSessions = new Set<string>(["s1"]);
		let prepareCalls = 0;
		const session = store.register({
			id: "s1",
			mediaFileId: "file-1",
			profileId: "profile-1",
			decision: createMockPlaybackDecision({ mode: "transcode", videoTranscode: true }),
			inputPath: "/media/f.mkv",
			tempDir: join(root, "s1"),
		});

		const result = await manager.retryWithSoftwareEncoder({
			sessionId: "s1",
			session,
			softwareFallbackSessions,
			prepareSession: () => {
				prepareCalls += 1;

				return Promise.resolve();
			},
			startSession: async () => {
				/* intentionally empty */
			},
		});

		expect(result).toBe(true);
		expect(prepareCalls).toBe(0);
	});

	test("retryWithSoftwareEncoder refuses for software decisions (nowhere left to fall back)", async () => {
		const store = createStore();
		const manager = new ProcessManager(config, store, new SessionReservationTracker(store, 1));
		const session = store.register({
			id: "s1",
			mediaFileId: "file-1",
			profileId: "profile-1",
			decision: createMockPlaybackDecision({ mode: "transcode", videoTranscode: true, forceSoftware: true }),
			inputPath: "/media/f.mkv",
			tempDir: join(root, "s1"),
		});

		// forceSoftware = true disqualifies the session from another fallback.
		const result = await manager.retryWithSoftwareEncoder({
			sessionId: "s1",
			session,
			softwareFallbackSessions: new Set<string>(),
			prepareSession: () => Promise.resolve(),
			startSession: () => Promise.resolve(),
		});

		expect(result).toBe(false);
	});
});
