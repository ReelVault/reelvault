import { describe, expect, spyOn, test } from "bun:test";
import { runRequestScenario, runScenarioMatrix } from "./harness";

const BOTH_LATENCY_LINE = / req\/s, p50 \d+\.\d{2}ms, p95 \d+\.\d{2}ms$/;

function startServer(): ReturnType<typeof Bun.serve> {
	return Bun.serve({
		port: 0,
		fetch: (request) => (new URL(request.url).pathname === "/fail" ? new Response("nope", { status: 500 }) : new Response("ok")),
	});
}

describe("runRequestScenario", () => {
	test("aggregates post-warmup success latencies under the given name", async () => {
		const server = startServer();
		try {
			const result = await runRequestScenario({
				name: "GET /ok",
				concurrency: 2,
				warmupMs: 5,
				durationMs: 30,
				requestFor: () => new Request(`${server.url}ok`),
			});
			expect(result.name).toBe("GET /ok");
			expect(result.errorRatePercent).toBe(0);
			expect(result.requestsPerSecond).toBeGreaterThan(0);
			expect(result.stats.count).toBeGreaterThan(0);
		} finally {
			await server.stop(true);
		}
	});

	test("accept overrides the default ok check", async () => {
		const server = startServer();
		try {
			const accepted = await runRequestScenario({
				name: "GET /fail (accepted)",
				concurrency: 1,
				warmupMs: 5,
				durationMs: 30,
				requestFor: () => new Request(`${server.url}fail`),
				accept: (response) => response.status === 500,
			});
			expect(accepted.errorRatePercent).toBe(0);
			expect(accepted.stats.count).toBeGreaterThan(0);

			const rejected = await runRequestScenario({
				name: "GET /fail",
				concurrency: 1,
				warmupMs: 5,
				durationMs: 30,
				requestFor: () => new Request(`${server.url}fail`),
			});
			expect(rejected.errorRatePercent).toBe(100);
			expect(rejected.stats.count).toBe(0);
		} finally {
			await server.stop(true);
		}
	});
});

describe("runScenarioMatrix", () => {
	test("runs the scenario × concurrency matrix with the shared log format", async () => {
		const server = startServer();
		const logged: string[] = [];
		const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			logged.push(args.map(String).join(" "));
		});
		try {
			const results = await runScenarioMatrix({
				suite: "unit",
				unit: "req/s",
				concurrency: [1, 2],
				warmupMs: 5,
				durationMs: 20,
				scenarios: [
					{ name: "a", requestFor: () => new Request(`${server.url}ok`) },
					{ name: "b", unit: "ops/s", work: async () => ({ ok: true }) },
				],
			});
			expect(results.map((result) => result.name)).toEqual(["c=1 a", "c=1 b", "c=2 a", "c=2 b"]);
			expect(logged).toContain("\n[unit] concurrency 1 (warmup 5ms, measure 20ms)");
			expect(logged.some((line) => line.startsWith("  a: ") && line.includes(" req/s, p95 "))).toBe(true);
			expect(logged.some((line) => line.startsWith("  b: ") && line.includes(" ops/s, p95 "))).toBe(true);
		} finally {
			spy.mockRestore();
			await server.stop(true);
		}
	});

	test("latency option selects the logged percentiles and precision", async () => {
		const server = startServer();
		const logged: string[] = [];
		const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			logged.push(args.map(String).join(" "));
		});
		try {
			await runScenarioMatrix({
				suite: "unit",
				unit: "req/s",
				latency: "both",
				latencyDigits: 2,
				concurrency: [1],
				warmupMs: 5,
				durationMs: 20,
				scenarios: [{ name: "a", requestFor: () => new Request(`${server.url}ok`) }],
			});
			expect(logged.some((line) => line.startsWith("  a: ") && BOTH_LATENCY_LINE.test(line))).toBe(true);
		} finally {
			spy.mockRestore();
			await server.stop(true);
		}
	});
});
