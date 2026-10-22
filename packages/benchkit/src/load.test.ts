import { describe, expect, test } from "bun:test";
import { sleep } from "bun";
import { identityIndexFor, runLoadWindow, subnetIp, weightedMix } from "./load.utils";

describe("runLoadWindow", () => {
	test("counts only post-warmup requests in the run totals", async () => {
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

describe("weightedMix", () => {
	test("replays the same picks for the same request indexes", () => {
		const pick = weightedMix([
			["a", 0.5],
			["b", 0.5],
		]);

		expect([0, 1, 2, 3].map((index) => pick(index))).toEqual(["a", "b", "b", "a"]);
	});

	test("spreads differently under another multiplier and falls back to the first entry past the weights", () => {
		const pick = weightedMix(
			[
				["a", 0.5],
				["b", 0.5],
			],
			40503,
		);
		const partial = weightedMix([
			["only", 0.1],
			["never", 0.1],
		]);

		expect([1, 2].map((index) => pick(index))).toEqual(["b", "a"]);
		expect(partial(1)).toBe("only");
	});
});

describe("client identities", () => {
	test("rotates a worker over the identities from its own offset", () => {
		expect(identityIndexFor(2, 5, 10)).toBe(9);
		expect(identityIndexFor(2, 6, 10)).toBe(0);
	});

	test("gives each worker an IP inside the suite's subnet", () => {
		expect(subnetIp(95, 0)).toBe("10.95.0.1");
		expect(subnetIp(95, 251)).toBe("10.95.1.2");
	});
});
