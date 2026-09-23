import { describe, expect, test } from "bun:test";
import { sleep } from "bun";
import { runLoadWindow } from "./load";

describe("runLoadWindow", () => {
	test("discards warmup samples and bounds the run to the deadline", async () => {
		let calls = 0;
		const run = await runLoadWindow({
			concurrency: 2,
			warmupMs: 40,
			durationMs: 60,
			work: async () => {
				calls++;
				await sleep(5);

				return { ok: true };
			},
		});
		expect(run.latencies.length).toBe(run.requests);
		expect(run.requests).toBeGreaterThan(0);
		expect(calls).toBeGreaterThan(run.requests);
		expect(run.failures).toBe(0);
		expect(run.successes).toBe(run.requests);
		expect(run.successLatencies.length).toBe(run.requests);
	});

	test("counts failures and keeps them out of successLatencies", async () => {
		let index = 0;
		const run = await runLoadWindow({
			concurrency: 1,
			warmupMs: 10,
			durationMs: 40,
			work: async () => {
				index++;
				await sleep(2);

				return { ok: index % 2 === 0 };
			},
		});
		expect(run.requests).toBe(run.successes + run.failures);
		expect(run.failures).toBeGreaterThan(0);
		expect(run.successes).toBeGreaterThan(0);
		expect(run.successLatencies.length).toBe(run.successes);
		expect(run.latencies.length).toBe(run.requests);
	});

	test("metrics are summed post-warmup by default and from start with accumulateFromStart", async () => {
		const measured = await runLoadWindow({
			concurrency: 1,
			warmupMs: 50,
			durationMs: 30,
			work: async () => {
				await sleep(1);

				return { ok: true, metrics: { bytes: 1 } };
			},
		});
		expect(measured.metrics.bytes).toBe(measured.requests);

		let calls = 0;
		const fromStart = await runLoadWindow({
			concurrency: 1,
			warmupMs: 50,
			durationMs: 30,
			accumulateFromStart: true,
			work: async () => {
				calls++;
				await sleep(1);

				return { ok: true, metrics: { bytes: 1 } };
			},
		});
		expect(fromStart.metrics.bytes).toBe(calls);
		expect(fromStart.metrics.bytes).toBeGreaterThan(fromStart.requests);
	});

	test("thrown errors count as failed samples", async () => {
		const run = await runLoadWindow({
			concurrency: 1,
			warmupMs: 5,
			durationMs: 30,
			work: () => Promise.reject(new Error("boom")),
		});
		expect(run.requests).toBe(run.failures);
		expect(run.successes).toBe(0);
	});
});
