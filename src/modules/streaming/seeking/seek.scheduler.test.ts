import { describe, expect, test } from "bun:test";
import { sleep } from "bun";
import { createMockPlaybackDecision } from "@/modules/streaming/streaming.helper";
import { SeekScheduler } from "./seek.scheduler";

const decision = createMockPlaybackDecision({ mode: "transcode" });

/** A promise the test settles by hand, to hold the executor at a known point. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
	let settle!: () => void;
	const promise = new Promise<void>((resolve) => {
		settle = resolve;
	});

	return { promise, resolve: settle };
}

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
		const gate = deferred();
		const firstStarted = deferred();
		const scheduler = new SeekScheduler(1, async (_sessionId, offset) => {
			started.push(offset);
			if (offset === 10) {
				firstStarted.resolve();
				await gate.promise;
			}

			return offset;
		});

		const first = scheduler.schedule("s1", 10, decision);
		await firstStarted.promise;
		const second = scheduler.schedule("s1", 20, decision);
		await sleep(15);

		// The second seek waits for the first to complete (mutex), even though its own debounce has already fired.
		expect(started).toEqual([10]);
		gate.resolve();
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
		const first = scheduler.schedule("s1", 10, decision);
		const second = scheduler.schedule("s2", 20, decision);

		scheduler.cancelAll("shutting down");

		await expect(first).rejects.toMatchObject({ category: "internal", code: "stream.seek_cancelled" });
		await expect(second).rejects.toMatchObject({ category: "internal", code: "stream.seek_cancelled" });
	});

	test("isSeeking is true only while the executor runs", async () => {
		const gate = deferred();
		const entered = deferred();
		const scheduler = new SeekScheduler(1, async () => {
			entered.resolve();
			await gate.promise;

			return 0;
		});

		const pending = scheduler.schedule("s1", 0, decision);
		expect(scheduler.isSeeking("s1")).toBe(false);
		await entered.promise;
		expect(scheduler.isSeeking("s1")).toBe(true);

		gate.resolve();
		await pending;
		expect(scheduler.isSeeking("s1")).toBe(false);
	});

	test("executor errors are delivered to all waiters", async () => {
		const failure = new Error("seek exploded");
		const scheduler = new SeekScheduler(1, () => Promise.reject(failure));

		const first = scheduler.schedule("s1", 10, decision);
		const second = scheduler.schedule("s1", 10, decision);
		const outcomes = await Promise.allSettled([first, second]);
		const reasons = outcomes.map((outcome) => (outcome.status === "rejected" ? outcome.reason : undefined));

		expect(reasons[0]).toBe(failure);
		expect(reasons[1]).toBe(failure);
	});
});
