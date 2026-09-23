import { describe, expect, test } from "bun:test";
import { createMockPlaybackDecision } from "../streaming.test-utils";
import { SessionStore } from "./sessions/session-store";
import { parseTimeToMs, TranscodeProgressMonitor, type TranscodeProgressMonitorDependencies } from "./transcode-progress.monitor";

function dependencies(overrides: Partial<TranscodeProgressMonitorDependencies> = {}): TranscodeProgressMonitorDependencies & {
	calls: { attach: string[]; progress: Array<{ operationId: string; percent: number }>; completed: string[]; released: string[] };
} {
	const calls = {
		attach: [] as string[],
		progress: [] as Array<{ operationId: string; percent: number }>,
		completed: [] as string[],
		released: [] as string[],
	};

	return {
		calls,
		attachStreamOperation: (operationId) => {
			calls.attach.push(operationId);

			return Promise.resolve();
		},
		updateOperationProgress: (operationId, percent) => {
			calls.progress.push({ operationId, percent });

			return Promise.resolve();
		},
		completeStreamOperation: (operationId) => {
			calls.completed.push(operationId);

			return Promise.resolve();
		},
		releaseStreamOperation: (operationId) => {
			calls.released.push(operationId);

			return Promise.resolve();
		},
		...overrides,
	};
}

function createStore(durationMs: number | null = 600_000): SessionStore {
	const store = new SessionStore();
	store.register({
		id: "s1",
		mediaFileId: "file-1",
		profileId: "p1",
		decision: createMockPlaybackDecision(),
		inputPath: "/tmp/x",
		tempDir: "/tmp/s1",
		durationMs,
	});
	store.setSessionOperation("s1", "op-1");

	return store;
}

describe("parseTimeToMs", () => {
	test("parses HH:MM:SS and MM:SS ffmpeg time values", () => {
		expect(parseTimeToMs("00:01:30.500")).toBe(90_500);
		expect(parseTimeToMs("01:00:00")).toBe(3_600_000);
		expect(parseTimeToMs("05:10")).toBe(310_000);
	});

	test("rejects garbage", () => {
		expect(parseTimeToMs("N/A")).toBeNull();
		expect(parseTimeToMs("")).toBeNull();
		expect(parseTimeToMs("1:2:3:4")).toBeNull();
	});
});

describe("TranscodeProgressMonitor", () => {
	test("computes percent from the session duration and writes it to the store and the operation", async () => {
		const store = createStore(600_000);
		const deps = dependencies();
		const monitor = new TranscodeProgressMonitor(deps);
		monitor.attachStore(store);

		await monitor.onFfmpegProgress("s1", { frame: 1, fps: 30, time: "00:05:00.000", speed: "4.2x" });

		expect(store.get("s1")?.transcodePositionMs).toBe(300_000);
		expect(store.get("s1")?.transcodePercent).toBe(50);
		expect(store.get("s1")?.transcodeSpeed).toBe("4.2x");
		expect(deps.calls.progress).toEqual([{ operationId: "op-1", percent: 50 }]);
	});

	test("without a known duration the position is tracked but no operation percent is written", async () => {
		const store = createStore(null);
		const deps = dependencies();
		const monitor = new TranscodeProgressMonitor(deps);
		monitor.attachStore(store);

		await monitor.onFfmpegProgress("s1", { frame: 1, fps: 30, time: "00:01:00.000", speed: "3.0x" });

		expect(store.get("s1")?.transcodePositionMs).toBe(60_000);
		expect(store.get("s1")?.transcodePercent).toBeNull();
		expect(deps.calls.progress).toEqual([]);
	});

	test("operation writes are throttled to one per second except a 100% edge", async () => {
		const store = createStore(600_000);
		const deps = dependencies();
		const monitor = new TranscodeProgressMonitor(deps);
		monitor.attachStore(store);

		await monitor.onFfmpegProgress("s1", { frame: 1, fps: 30, time: "00:05:00.000", speed: "4x" });
		await monitor.onFfmpegProgress("s1", { frame: 2, fps: 30, time: "00:05:06.000", speed: "4x" });
		await monitor.onFfmpegProgress("s1", { frame: 3, fps: 30, time: "00:10:00.000", speed: "4x" });

		// 51% lands inside the throttle window and is dropped; 100% always lands.
		expect(deps.calls.progress).toEqual([
			{ operationId: "op-1", percent: 50 },
			{ operationId: "op-1", percent: 100 },
		]);
		expect(store.get("s1")?.transcodePercent).toBe(100);

		await monitor.onFfmpegProgress("s1", { frame: 4, fps: 30, time: "00:10:00.000", speed: "4x" });
		expect(deps.calls.progress).toHaveLength(2);
	});

	test("a natural EOF closes the operation at 100%, a kill does not", async () => {
		const store = createStore(600_000);
		const deps = dependencies();
		const monitor = new TranscodeProgressMonitor(deps);
		monitor.attachStore(store);

		await monitor.onFfmpegExit("s1", 0, null);
		expect(deps.calls.completed).toEqual(["op-1"]);
		expect(store.get("s1")?.transcodePercent).toBe(100);
		expect(store.get("s1")?.transcodePositionMs).toBe(600_000);

		await monitor.onFfmpegExit("s1", 0, 15);
		await monitor.onFfmpegExit("s1", 1, null);
		expect(deps.calls.completed).toHaveLength(1);
	});

	test("claims the streaming slot once per session and re-claims it after a natural EOF", async () => {
		const store = createStore(600_000);
		const deps = dependencies();
		const monitor = new TranscodeProgressMonitor(deps);
		monitor.attachStore(store);

		await monitor.onProcessAttached("s1");
		await monitor.onProcessAttached("s1");
		expect(deps.calls.attach).toEqual(["op-1"]);

		// A kill keeps the slot (seek restart); a natural EOF frees it for a later start.
		await monitor.onFfmpegExit("s1", 0, 15);
		await monitor.onProcessAttached("s1");
		expect(deps.calls.attach).toEqual(["op-1"]);

		await monitor.onFfmpegExit("s1", 0, null);
		await monitor.onProcessAttached("s1");
		expect(deps.calls.attach).toEqual(["op-1", "op-1"]);
	});

	test("session release clears throttle state and releases the slot", async () => {
		const store = createStore(600_000);
		const deps = dependencies();
		const monitor = new TranscodeProgressMonitor(deps);
		monitor.attachStore(store);

		await monitor.onSessionReleased("s1", "op-1");
		expect(deps.calls.released).toEqual(["op-1"]);
	});

	test("an unknown session or a store-less monitor is a no-op", async () => {
		const deps = dependencies();
		const monitor = new TranscodeProgressMonitor(deps);

		await monitor.onFfmpegProgress("missing", { frame: 1, fps: 30, time: "00:01:00.000", speed: "1x" });
		await monitor.onFfmpegExit("missing", 0, null);
		await monitor.onProcessAttached("missing");
		await monitor.onSessionReleased("missing", "op-x");

		expect(deps.calls.progress).toEqual([]);
		expect(deps.calls.completed).toEqual([]);
		expect(deps.calls.attach).toEqual([]);
		expect(deps.calls.released).toEqual(["op-x"]);

		const idle = new TranscodeProgressMonitor(dependencies());
		await idle.onFfmpegProgress("s1", { frame: 1, fps: 30, time: "00:01:00.000", speed: "1x" });
	});
});
