import {
	fmtMs,
	type HttpScenarioResult,
	type HttpScenarioRun,
	main,
	printHttpResults,
	printTable,
	runHttpScenario,
	suiteArgs,
	summarizeLatencies,
	task,
} from "benchkit";

import type { ManagedServer } from "./lib/server";
import { createServerFixture } from "./lib/server-fixture";

/**
 * Image pipeline suite beyond the single ?w=342 GET in http.ts:
 *  - the width matrix clients actually use,
 *  - LRU churn — cycling far more distinct widths than the variant cache can
 *    hold, exposing eviction behavior,
 *  - thundering-herd dedup — N parallel first-time requests for the same
 *    variant must collapse to one Sharp encode (in-flight dedup).
 */

function imageHeaders(server: ManagedServer): Record<string, string> {
	return { cookie: server.cookie, "x-forwarded-for": "10.85.0.1" };
}

function runDurationScenario(
	server: ManagedServer,
	urlFor: (requestIndex: number) => string,
	concurrency: number,
	warmupMs: number,
	durationMs: number,
): Promise<HttpScenarioRun> {
	return runHttpScenario({
		concurrency,
		warmupMs,
		durationMs,
		work: async (requestIndex) => {
			try {
				const response = await fetch(urlFor(requestIndex), { headers: imageHeaders(server) });
				const ok = response.ok;
				await response.arrayBuffer();

				return { ok };
			} catch {
				return { ok: false };
			}
		},
	});
}

function summarizeRun(name: string, run: HttpScenarioRun, durationMs: number): HttpScenarioResult {
	const stats = summarizeLatencies(run.latencies);
	const rps = run.successes / (durationMs / 1000);
	const errorRate = run.requests > 0 ? ((run.requests - run.successes) / run.requests) * 100 : 0;

	return { name, stats, requestsPerSecond: rps, errorRatePercent: errorRate };
}

export const meta = { description: "Image pipeline (width matrix, variant-cache LRU churn, thundering-herd dedup)" };

const args = suiteArgs();

if (!args.help) {
	const serverFixture = createServerFixture({
		seedRows: args.rows,
		workerCount: Math.max(...args.concurrency),
		keepServer: args.keepServer,
	});

	task("images: pipeline", async () => {
		let server: ManagedServer | undefined;
		try {
			server = await serverFixture();
			const managed = server;
			const imageUrl = (width: number): string => `${managed.baseUrl}/v1/images/${managed.benchmarkImageId}?w=${width}`;

			const results: HttpScenarioResult[] = [];
			const concurrency = args.concurrency[0] ?? 10;
			console.log(`\n[images] concurrency ${concurrency} (warmup ${args.warmupMs}ms, measure ${args.durationMs}ms)`);

			// Width matrix — every request stays on one width so the variant cache serves it warm.
			const widths = [342, 780, 1280, 1920];
			for (const width of widths) {
				const run = await runDurationScenario(server, () => imageUrl(width), concurrency, args.warmupMs, args.durationMs);
				const result = summarizeRun(`GET /v1/images/:id?w=${width} (warm variant)`, run, args.durationMs);
				results.push(result);
				console.log(`  w=${width}: ${result.requestsPerSecond.toFixed(0)} req/s, p95 ${result.stats.p95Ms.toFixed(1)}ms`);
			}

			// LRU churn — far more distinct widths than the variant cache holds.
			const churn = await runDurationScenario(
				server,
				(requestIndex) => imageUrl(200 + (requestIndex % 4000)),
				concurrency,
				args.warmupMs,
				args.durationMs,
			);
			const churnResult = summarizeRun("GET /v1/images/:id?w=200..4200 (LRU churn, all misses)", churn, args.durationMs);
			results.push(churnResult);
			console.log(`  churn: ${churnResult.requestsPerSecond.toFixed(0)} req/s, p95 ${churnResult.stats.p95Ms.toFixed(1)}ms`);

			// Thundering herd — 50 parallel first-time requests for the SAME new
			// variant; in-flight dedup should collapse them to one encode, so the
			// batch wall time must sit near a single cold encode, not 50×.
			const herdBatches = 5;
			const herdWalls: number[] = [];
			let herdBatch = 0;
			while (herdBatch < herdBatches) {
				const width = 5000 + herdBatch;
				herdBatch++;
				const batchStartedAt = performance.now();
				const responses = await Promise.all(Array.from({ length: 50 }, () => fetch(imageUrl(width), { headers: imageHeaders(managed) })));
				await Promise.all(responses.map((response) => response.arrayBuffer()));
				herdWalls.push(performance.now() - batchStartedAt);
			}

			const herdStats = summarizeLatencies(herdWalls);
			printTable(
				"Thundering herd (50 parallel first-time requests, same variant)",
				["batches", "batch wall p50", "p95"],
				[[String(herdBatches), fmtMs(herdStats.p50Ms), fmtMs(herdStats.p95Ms)]],
			);

			printHttpResults(results);
		} finally {
			if (!args.keepServer) {
				await server?.stop();
			}
		}
	});
}

await main(import.meta);
