import { describe, expect, test } from "bun:test";
import { sleep } from "bun";
import { createMockPlaybackDecision } from "../streaming.test-utils";
import { SeekScheduler } from "./seek.scheduler";

const decision = createMockPlaybackDecision({ mode: "transcode" });

describe("seek scheduler", () => {
	test("debounces rapid seeks into a single execution with the last offset", async () => {
		const executions: number[] = [];
		const scheduler = new SeekScheduler(10, (_sessionId, offset) => {
			executions.push(offset);

			return Promise.resolve(offset);
		});

		const first = scheduler.schedule("s1", 10, decision);
		const second = scheduler.schedule("s1", 20, decision);
		const third = scheduler.schedule("s1", 30, decision);

		const results = await Promise.all([first, second, third]);

		// The awaited results already prove the executor ran (exactly once, last offset).
		expect(executions).toEqual([30]);
		expect(results.map((result) => result.startTime)).toEqual([30, 30, 30]);
		expect(results.map((result) => result.reusedBuffer)).toEqual([false, false, false]);
	});

	test("serializes flushes per session through the mutex chain", async () => {
		const started: number[] = [];
		let releaseSecond!: () => void;
		const gate = new Promise<void>((resolve) => {
			releaseSecond = resolve;
		});
		const scheduler = new SeekScheduler(1, async (_sessionId, offset) => {
			started.push(offset);
			if (offset === 10) await gate;

			return offset;
		});

		const first = scheduler.schedule("s1", 10, decision);
		await sleep(15);
		const second = scheduler.schedule("s1", 20, decision);
		await sleep(15);

		// The second seek waits for the first to complete (mutex), even though the timer has already fired.
		expect(started).toEqual([10]);
		releaseSecond();
		expect(await second).toMatchObject({ startTime: 20 });
		expect(await first).toMatchObject({ startTime: 10 });
		expect(started).toEqual([10, 20]);
	});

	test("resolves immediately with a buffered result and cancels pending debounces", async () => {
		const executions: number[] = [];
		const scheduler = new SeekScheduler(50, (_sessionId, offset) => {
			executions.push(offset);

			return Promise.resolve(offset);
		});

		const pending = scheduler.schedule("s1", 10, decision);
		scheduler.resolveWithBufferedResult("s1", { startTime: 5, reusedBuffer: true });

		expect(await pending).toEqual({ startTime: 5, reusedBuffer: true });
		await sleep(70);
		expect(executions).toEqual([]);
	});

	test("cancelAll rejects every pending seek", async () => {
		const scheduler = new SeekScheduler(50, async (_sessionId, offset) => offset);
		const pending = scheduler.schedule("s1", 10, decision);

		scheduler.cancelAll("shutting down");

		await expect(pending).rejects.toThrow("shutting down");
	});

	test("isSeeking is true only while the executor runs", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const scheduler = new SeekScheduler(1, async () => {
			await gate;

			return 0;
		});

		const pending = scheduler.schedule("s1", 0, decision);
		await sleep(15);
		expect(scheduler.isSeeking("s1")).toBe(true);

		release();
		await pending;
		expect(scheduler.isSeeking("s1")).toBe(false);
	});

	test("executor errors are delivered to all waiters", async () => {
		const scheduler = new SeekScheduler(1, () => Promise.reject(new Error("seek exploded")));

		const first = scheduler.schedule("s1", 10, decision);
		const second = scheduler.schedule("s1", 10, decision);
		const results = await Promise.allSettled([first, second]);

		expect(results.every((result) => result.status === "rejected")).toBe(true);
		expect(results.filter((result) => result.status === "rejected").map((result) => result.reason.message)).toEqual([
			"seek exploded",
			"seek exploded",
		]);
	});
});
