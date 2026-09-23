import { afterAll, describe, expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscodeConfig } from "@reelvault/sdk/common";
import { $, spawn } from "bun";
import { SessionReservationTracker } from "../runtime/sessions/session-reservation.tracker";
import { SessionStore } from "../runtime/sessions/session-store";
import { createMockPlaybackDecision } from "../streaming.test-utils";
import { ProcessManager } from "./process-manager";

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
			manager.startSession("s1", session, "/media/f.mkv", createMockPlaybackDecision({ mode: "transcode" }), 0, 0),
		).rejects.toThrow("Concurrent stream limit reached");
	});

	test("ensureTempDirectory creates a clean directory", async () => {
		const store = createStore();
		const manager = new ProcessManager(config, store, new SessionReservationTracker(store, 1));
		const tempDir = join(root, "session-1");

		await manager.ensureTempDirectory(tempDir);

		const stats = await stat(tempDir);
		expect(stats.isDirectory()).toBe(true);
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

		const result = await manager.retryWithSoftwareEncoder(
			"s1",
			session,
			softwareFallbackSessions,
			() => {
				prepareCalls += 1;

				return Promise.resolve();
			},
			async () => {
				/* intentionally empty */
			},
		);

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
		const result = await manager.retryWithSoftwareEncoder(
			"s1",
			session,
			new Set<string>(),
			() => Promise.resolve(),
			() => Promise.resolve(),
		);

		expect(result).toBe(false);
	});
});
