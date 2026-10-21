import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { createMockPlaybackDecision } from "@/modules/streaming/streaming.helper";
import { workerOperationRepository } from "@/repositories/worker-operation.repository";
import { type MethodStub, stubMethod } from "../../../../tests/helpers/method-stub.helper";
import { useTestDatabase } from "../../../../tests/helpers/test-database.helper";
import { SessionStore } from "./session-state/session.store";
import { parseTimeToMs, TranscodeProgressMonitor } from "./transcode-progress.monitor";

const db = useTestDatabase();
const START_MS = 1_000_000;
let clockMs = START_MS;
let clock: MethodStub;

beforeEach(async () => {
	clockMs = START_MS;
	clock = stubMethod(Date, "now", () => clockMs);
	await workerOperationRepository.create({ id: "op-1", type: "streaming-session" });
});

afterEach(() => {
	clock.restore();
});

function createStore(durationMs: number | null = 600_000): SessionStore {
	const store = new SessionStore();
	store.register({
		id: "s1",
		mediaFileId: "file-1",
		profileId: "p1",
		decision: createMockPlaybackDecision(),
		inputPath: "/media/input.mkv",
		tempDir: "/tmp/s1",
		durationMs,
	});
	store.setSessionOperation("s1", "op-1");

	return store;
}

function startMonitor(store: SessionStore): TranscodeProgressMonitor {
	const monitor = new TranscodeProgressMonitor();
	monitor.attachStore(store);

	return monitor;
}

function ffmpegProgress(time: string, speed = "4.0x") {
	return { frame: 1, fps: 30, time, speed };
}

async function progressInDb(): Promise<number | null | undefined> {
	return (await workerOperationRepository.findById("op-1"))?.progressPercent;
}

async function runningSlotsInDb(): Promise<number | undefined> {
	return (await workerOperationRepository.findById("op-1"))?.runningItems;
}

describe("parseTimeToMs", () => {
	test.each([
		["00:01:30.500", 90_500],
		["01:00:00", 3_600_000],
		["05:10", 310_000],
	])("reads the ffmpeg time stamp %s as %i milliseconds", (time, milliseconds) => {
		expect(parseTimeToMs(time)).toBe(milliseconds);
	});

	test.each(["N/A", "", "1:2:3:4"])("returns null for the value %j", (time) => {
		expect(parseTimeToMs(time)).toBeNull();
	});
});

describe("TranscodeProgressMonitor progress", () => {
	test("writes the transcode percent to the session and to its streaming operation", async () => {
		const store = createStore(600_000);

		await startMonitor(store).onFfmpegProgress("s1", ffmpegProgress("00:05:00.000", "4.2x"));

		expect(store.get("s1")).toMatchObject({ transcodePositionMs: 300_000, transcodePercent: 50, transcodeSpeed: "4.2x" });
		expect(await progressInDb()).toBe(50);
	});

	test("leaves the operation's progress unset when the session duration is unknown", async () => {
		const store = createStore(null);

		await startMonitor(store).onFfmpegProgress("s1", ffmpegProgress("00:01:00.000", "3.0x"));

		expect(store.get("s1")).toMatchObject({ transcodePositionMs: 60_000, transcodePercent: null });
		expect(await progressInDb()).toBeNull();
	});

	test("throttles operation writes to one per second but always writes 100%", async () => {
		const monitor = startMonitor(createStore(600_000));

		await monitor.onFfmpegProgress("s1", ffmpegProgress("00:05:00.000"));
		expect(await progressInDb()).toBe(50);

		clockMs += 500;
		await monitor.onFfmpegProgress("s1", ffmpegProgress("00:06:00.000"));
		expect(await progressInDb()).toBe(50);

		clockMs += 500;
		await monitor.onFfmpegProgress("s1", ffmpegProgress("00:06:00.000"));
		expect(await progressInDb()).toBe(60);

		clockMs += 100;
		await monitor.onFfmpegProgress("s1", ffmpegProgress("00:10:00.000"));
		expect(await progressInDb()).toBe(100);
	});

	test("ignores events for a session the monitor does not track", async () => {
		const monitor = startMonitor(createStore(600_000));

		await monitor.onFfmpegProgress("missing", ffmpegProgress("00:05:00.000"));
		await monitor.onFfmpegExit("missing", 0, null);
		await monitor.onProcessAttached("missing");

		expect(await progressInDb()).toBeNull();
		expect(await runningSlotsInDb()).toBe(0);
	});
});

describe("TranscodeProgressMonitor streaming slot", () => {
	test("a natural EOF releases the streaming slot and reports 100%, while a kill keeps the slot", async () => {
		const store = createStore(600_000);
		const monitor = startMonitor(store);

		await monitor.onProcessAttached("s1");
		expect(await runningSlotsInDb()).toBe(1);

		await monitor.onFfmpegExit("s1", 0, 15);
		expect(await runningSlotsInDb()).toBe(1);

		await monitor.onFfmpegExit("s1", 0, null);
		expect(await runningSlotsInDb()).toBe(0);
		expect(store.get("s1")).toMatchObject({ transcodePercent: 100, transcodePositionMs: 600_000 });
	});

	test("claims the slot once per session and reclaims it only after a natural EOF", async () => {
		const monitor = startMonitor(createStore(600_000));

		await monitor.onProcessAttached("s1");
		await monitor.onProcessAttached("s1");
		expect(await runningSlotsInDb()).toBe(1);

		await monitor.onFfmpegExit("s1", 0, 15);
		await monitor.onProcessAttached("s1");
		expect(await runningSlotsInDb()).toBe(1);

		await monitor.onFfmpegExit("s1", 0, null);
		expect(await runningSlotsInDb()).toBe(0);
		await monitor.onProcessAttached("s1");
		expect(await runningSlotsInDb()).toBe(1);
	});

	test("a late slot claim does not resurrect a cancelled operation", async () => {
		await db
			.client()
			.update(schema.workerOperations)
			.set({ status: "cancelled", cancelRequested: true })
			.where(eq(schema.workerOperations.id, "op-1"));

		await startMonitor(createStore(600_000)).onProcessAttached("s1");

		expect(await workerOperationRepository.findById("op-1")).toMatchObject({ status: "cancelled", runningItems: 0 });
	});

	test("releasing a session frees its streaming slot and clears its progress throttle", async () => {
		const monitor = startMonitor(createStore(600_000));
		await monitor.onProcessAttached("s1");
		await monitor.onFfmpegProgress("s1", ffmpegProgress("00:05:00.000"));

		clockMs += 100;
		await monitor.onSessionReleased("s1", "op-1");
		expect(await runningSlotsInDb()).toBe(0);

		// Still inside the one-second window of the 50% write: only a cleared throttle lets 60% land.
		clockMs += 100;
		await monitor.onFfmpegProgress("s1", ffmpegProgress("00:06:00.000"));
		expect(await progressInDb()).toBe(60);
	});
});
