import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	benchmarkAsync,
	fmtMs,
	type HttpScenarioResult,
	main,
	printHttpResults,
	printMicroResults,
	printTable,
	runRequestScenario,
	suiteArgs,
	summarizeLatencies,
	task,
} from "benchkit";
import { adminHeaders } from "./lib/identity";
import { suiteServerFixture } from "./lib/server-fixture";

/**
 * Image pipeline suite beyond the single ?w=342 GET in http.ts:
 *  - the width matrix clients actually use,
 *  - LRU churn — cycling far more distinct widths than the variant cache can
 *    hold, exposing eviction behavior,
 *  - thundering-herd dedup — N parallel first-time requests for the same
 *    variant must collapse to one Sharp encode (in-flight dedup).
 */

export const meta = { description: "Image pipeline (width matrix, variant-cache LRU churn, thundering-herd dedup)" };

const args = suiteArgs();

if (!args.help) {
	const serverFixture = suiteServerFixture(args);

	// Local sidecar artwork is copied to a temp source before Sharp reads it.
	// Characterise routing the bytes through JS versus a kernel copy.
	task("images: local artwork copy", async () => {
		const directory = await mkdtemp(join(tmpdir(), "reelvault-image-copy-"));
		try {
			const source = join(directory, "source.jpg");
			await writeFile(source, Buffer.alloc(20 * 1024 * 1024, 1));

			const results = [
				await benchmarkAsync(
					"readFile + writeFile (20 MB)",
					async () => {
						await writeFile(join(directory, "via-buffer.jpg"), await readFile(source));
					},
					{ warmup: 2, iterations: 10 },
				),
				await benchmarkAsync(
					"copyFile (20 MB)",
					async () => {
						await copyFile(source, join(directory, "via-copy.jpg"));
					},
					{ warmup: 2, iterations: 10 },
				),
			];
			printMicroResults(results, "Local artwork staging (20 MB file)");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}

		return { ok: true };
	});

	task("images: pipeline", async () => {
		const managed = await serverFixture();
		const imageUrl = (width: number): string => `${managed.baseUrl}/v1/images/${managed.benchmarkImageId}?w=${width}`;

		const results: HttpScenarioResult[] = [];
		const concurrency = args.concurrency[0] ?? 10;
		console.log(`\n[images] concurrency ${concurrency} (warmup ${args.warmupMs}ms, measure ${args.durationMs}ms)`);

		// Width matrix — every request stays on one width so the variant cache serves it warm.
		const widths = [342, 780, 1280, 1920];
		for (const width of widths) {
			const result = await runRequestScenario({
				name: `GET /v1/images/:id?w=${width} (warm variant)`,
				concurrency,
				warmupMs: args.warmupMs,
				durationMs: args.durationMs,
				requestFor: () => new Request(imageUrl(width), { headers: adminHeaders(managed, "10.85.0.1", false) }),
			});
			results.push(result);
			console.log(`  w=${width}: ${result.requestsPerSecond.toFixed(0)} req/s, p95 ${result.stats.p95Ms.toFixed(1)}ms`);
		}

		// LRU churn — far more distinct widths than the variant cache holds.
		// Pre-existing load pattern: the width keys off the worker index.
		const churnResult = await runRequestScenario({
			name: "GET /v1/images/:id?w=200..4200 (LRU churn, all misses)",
			concurrency,
			warmupMs: args.warmupMs,
			durationMs: args.durationMs,
			requestFor: (workerIndex) =>
				new Request(imageUrl(200 + (workerIndex % 4000)), { headers: adminHeaders(managed, "10.85.0.1", false) }),
		});
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
			const responses = await Promise.all(
				Array.from({ length: 50 }, () => fetch(imageUrl(width), { headers: adminHeaders(managed, "10.85.0.1", false) })),
			);
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
	});
}

await main(import.meta);
