import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlaybackDecision, StreamingSession, TranscodeConfig } from "@reelvault/sdk/common";
import { type Subprocess, spawn } from "bun";
import { SessionStore } from "@/modules/streaming/runtime/session-state/session.store";
import { SessionReservationTracker } from "@/modules/streaming/runtime/session-state/session-reservation.tracker";
import { createMockPlaybackDecision } from "@/modules/streaming/streaming.helper";
import { type MethodStub, stubMethod } from "../../../../tests/helpers/method-stub.helper";
import { mockModuleWithRealExports, restoreModuleMocks } from "../../../../tests/helpers/module-mock.helper";

const root = join(tmpdir(), `reelvault-process-manager-start-${Date.now()}`);
const processCalls = { killed: [] as Subprocess[], waited: [] as Subprocess[] };
const fakeProcess = spawn(["sleep", "30"]);
let onStart: (() => void) | undefined;
const fakeStrategy = {
	startSession: (): Promise<Subprocess> => {
		onStart?.();

		return Promise.resolve(fakeProcess);
	},
};
const fakeRegistry = { "direct-stream": fakeStrategy, transcode: fakeStrategy };

mockModuleWithRealExports("@/modules/streaming/ffmpeg/strategies/strategy.factory", { createStrategyRegistry: () => fakeRegistry });
mockModuleWithRealExports("@/integrations/ffmpeg/ffmpeg.process", {
	killFfmpegProcessGracefully: (process: Subprocess) => {
		processCalls.killed.push(process);

		return Promise.resolve();
	},
	waitForExitWithTimeout: (process: Subprocess) => {
		processCalls.waited.push(process);

		return Promise.resolve();
	},
});
mockModuleWithRealExports("@/integrations/ffmpeg/ffmpeg.capabilities", { getEffectiveHwaccel: () => ({ type: "nvenc" }) });

const { ProcessManager } = await import("./process.manager");

const config: TranscodeConfig = {
	maxSessions: 1,
	inactivityTimeout: 60_000,
	cleanupInterval: 60_000,
	tempRootDir: root,
	hlsSegmentDuration: 4,
};

function createManager(): { manager: InstanceType<typeof ProcessManager>; store: SessionStore } {
	const store = new SessionStore();

	return { manager: new ProcessManager(config, store, new SessionReservationTracker(store, 1)), store };
}

function registerSession(store: SessionStore, id: string, generation = 0): StreamingSession {
	const session = store.register({
		id,
		mediaFileId: `file-${id}`,
		profileId: "profile-1",
		decision: createMockPlaybackDecision({ mode: "transcode" }),
		inputPath: `/media/${id}.mkv`,
		tempDir: join(root, id),
	});
	session.generation = generation;

	return session;
}

function decision(mode: PlaybackDecision["mode"] = "transcode"): PlaybackDecision {
	return createMockPlaybackDecision({ mode });
}

let activeStub: MethodStub | undefined;

beforeEach(() => {
	processCalls.killed.length = 0;
	processCalls.waited.length = 0;
	onStart = undefined;
});

afterEach(() => {
	activeStub?.restore();
	activeStub = undefined;
});

afterAll(async () => {
	fakeProcess.kill();
	restoreModuleMocks();
	await rm(root, { recursive: true, force: true });
});

describe("ProcessManager.startSession", () => {
	test("starts a process, records the operation and attaches the process to the session", async () => {
		const { manager, store } = createManager();
		const session = registerSession(store, "s1");

		await manager.startSession({
			sessionId: "s1",
			session,
			inputPath: "/media/s1.mkv",
			decision: decision(),
			startTime: 12,
			timelineStart: 34,
			operationId: "op-1",
		});

		expect(session.operationId).toBe("op-1");
		expect(session.process).toBe(fakeProcess);
		expect(session.generation).toBe(1);
		expect(store.attachedCount()).toBe(1);
	});

	test("a restart bypasses the full-session limit", async () => {
		const { manager, store } = createManager();
		const occupied = registerSession(store, "occupied");
		store.attachProcess("occupied", fakeProcess, 0);
		const restarted = registerSession(store, "restart", 1);

		await manager.startSession({
			sessionId: "restart",
			session: restarted,
			inputPath: "/media/restart.mkv",
			decision: decision(),
			startTime: 0,
			timelineStart: 0,
		});

		expect(restarted.process).toBe(fakeProcess);
		expect(occupied.process).toBe(fakeProcess);
	});

	test("reports the active count and retry delay when the server limit is reached", async () => {
		const { manager, store } = createManager();
		registerSession(store, "occupied");
		store.attachProcess("occupied", fakeProcess, 0);
		const session = registerSession(store, "s1");

		const failure = await manager
			.startSession({
				sessionId: "s1",
				session,
				inputPath: "/media/s1.mkv",
				decision: decision(),
				startTime: 0,
				timelineStart: 0,
			})
			.catch((error: unknown) => error);

		expect(failure).toMatchObject({
			category: "too_many_requests",
			code: "stream.limit_reached",
			params: { scope: "server", limit: 1, active: 1 },
		});
	});

	test("stops the previous process before starting a replacement", async () => {
		const { manager, store } = createManager();
		const previous = spawn(["sleep", "30"]);
		const session = registerSession(store, "s1");
		store.attachProcess("s1", previous, 0);

		try {
			await manager.startSession({
				sessionId: "s1",
				session,
				inputPath: "/media/s1.mkv",
				decision: decision(),
				startTime: 0,
				timelineStart: 0,
			});
		} finally {
			previous.kill();
		}

		expect(processCalls.killed).toContain(previous);
		expect(session.process).toBe(fakeProcess);
	});
});

describe("ProcessManager.startSession rollback", () => {
	test("kills the started process and rethrows when attaching it fails", async () => {
		const { manager, store } = createManager();
		const session = registerSession(store, "s1");
		const attachError = new Error("attach failed");
		activeStub = stubMethod(store, "attachProcess", () => {
			throw attachError;
		});

		await expect(
			manager.startSession({
				sessionId: "s1",
				session,
				inputPath: "/media/s1.mkv",
				decision: decision(),
				startTime: 0,
				timelineStart: 0,
			}),
		).rejects.toBe(attachError);

		expect(processCalls.killed).toContain(fakeProcess);
		expect(session.process).toBeNull();
	});

	test("kills the started process when the signal aborts during start", async () => {
		const { manager, store } = createManager();
		const session = registerSession(store, "s1");
		const controller = new AbortController();
		onStart = () => controller.abort();

		await expect(
			manager.startSession({
				sessionId: "s1",
				session,
				inputPath: "/media/s1.mkv",
				decision: decision(),
				startTime: 0,
				timelineStart: 0,
				signal: controller.signal,
			}),
		).rejects.toMatchObject({ name: "AbortError" });

		expect(processCalls.killed).toContain(fakeProcess);
		expect(session.process).toBeNull();
	});
});

describe("ProcessManager.stopRunningProcess", () => {
	test("kills, waits for and detaches the current process", async () => {
		const { manager, store } = createManager();
		const session = registerSession(store, "s1");
		store.attachProcess("s1", fakeProcess, 0);

		await manager.stopRunningProcess("s1", session);

		expect(processCalls.killed).toContain(fakeProcess);
		expect(processCalls.waited).toContain(fakeProcess);
		expect(session.process).toBeNull();
	});

	test("does nothing when the session has no process", async () => {
		const { manager, store } = createManager();
		const session = registerSession(store, "s1");

		await manager.stopRunningProcess("s1", session);

		expect(processCalls.killed).toEqual([]);
		expect(session.process).toBeNull();
	});
});

describe("ProcessManager.retryWithSoftwareEncoder", () => {
	test("marks the session for a software retry and prepares it before starting", async () => {
		const { manager, store } = createManager();
		const session = registerSession(store, "s1");
		session.decision = createMockPlaybackDecision({ mode: "transcode", videoTranscode: true });
		const calls: string[] = [];
		const fallbackSessions = new Set<string>();

		const retried = await manager.retryWithSoftwareEncoder({
			sessionId: "s1",
			session,
			softwareFallbackSessions: fallbackSessions,
			prepareSession: () => {
				calls.push("prepare");

				return Promise.resolve();
			},
			startSession: () => {
				calls.push("start");

				return Promise.resolve();
			},
		});

		expect(retried).toBe(true);
		expect(calls).toEqual(["prepare", "start"]);
		expect(fallbackSessions.has("s1")).toBe(true);
		expect(session.decision.forceSoftware).toBe(true);
	});

	test("clears the one-shot guard when the software retry fails", async () => {
		const { manager, store } = createManager();
		const session = registerSession(store, "s1");
		session.decision = createMockPlaybackDecision({ mode: "transcode", videoTranscode: true });
		const fallbackSessions = new Set<string>();

		const retried = await manager.retryWithSoftwareEncoder({
			sessionId: "s1",
			session,
			softwareFallbackSessions: fallbackSessions,
			prepareSession: () => Promise.reject(new Error("prepare failed")),
			startSession: () => Promise.resolve(),
		});

		expect(retried).toBe(false);
		expect(fallbackSessions.has("s1")).toBe(false);
	});
});
