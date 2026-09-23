import {
	bench,
	benchmarkAsync,
	fmtMs,
	type MicroBenchmarkResult,
	main,
	printMicroResults,
	printTable,
	suiteArgs,
	summarizeLatencies,
	task,
} from "benchkit";
import { sleep } from "bun";
import { databaseFactory } from "@/database/database";
import { workerJobRepository } from "@/database/repositories/worker.repository";

export const meta = { description: "Worker job queue engine (bulk enqueue, dedupe, claimNextBatch transaction)" };

const WORKER_ID = "media-file-analysis";
/** Backlogs to probe the claim query at — the temp-sort/index tradeoff changes with size. */
const BACKLOG_SIZES = [0, 1_000, 10_000, 50_000];
/** claimNextBatch calls measured per backlog (stays under the running-count ceiling). */
const CLAIM_PROBES = 10;
/**
 * Claim probes must use a realistic worker concurrency: the repository sizes its
 * candidate query at `max(max, 20, concurrency * 2)`, so an inflated concurrency
 * would materialize a huge candidate set and fake an O(backlog) claim cost.
 */
const CLAIM_CONCURRENCY = 300;

function enqueueInput(id: string, workerId = WORKER_ID) {
	return {
		id,
		workerId,
		data: JSON.stringify({ fileId: id }),
		priority: 0,
		maxAttempts: 3,
		backoffType: "exponential" as const,
		backoffDelayMs: 1000,
		runAt: new Date(),
	};
}

/** Seeds pending jobs with raw SQL so backlog setup is not part of the measured claim path. */
function seedBacklog(workerId: string, count: number, status: "pending" | "completed" = "pending"): void {
	const db = databaseFactory.sqlite;
	const insert = db.prepare(
		"INSERT INTO worker_jobs (id, worker_id, data, status, priority, attempts, max_attempts, run_at, completed_at, created_at, updated_at) VALUES (?, ?, '{}', ?, 0, 0, 3, ?, ?, ?, ?)",
	);
	// Drizzle's `timestamp` mode binds/reads epoch SECONDS, so raw seed values
	// must be seconds too — milliseconds put `run_at` ~50 000 years in the future
	// and nothing is ever claimable.
	const nowSec = Math.floor(Date.now() / 1000);
	db.run("BEGIN");
	for (let index = 0; index < count; index++) {
		const completed = status === "completed";
		const completedAt = completed ? nowSec - index : null;
		const createdAt = completed ? nowSec - index : nowSec + index;
		insert.run(`${workerId}-job-${index}`, workerId, status, nowSec - index, completedAt, createdAt, nowSec + index);
	}

	db.run("COMMIT");
	// Production refreshes statistics after bulk writes (boot / scan / daily
	// maintenance); without them the claim query sorts the whole backlog.
	databaseFactory.analyze();
}

function clearBacklog(workerId: string): void {
	databaseFactory.sqlite.prepare("DELETE FROM worker_jobs WHERE worker_id = ?").run(workerId);
}

/** Measures claimNextBatch latency while a backlog of `backlog` pending jobs exists. */
async function measureClaimAtBacklog(workerId: string, backlog: number, maxPerCall: number): Promise<MicroBenchmarkResult> {
	if (backlog > 0) seedBacklog(workerId, backlog);

	const claim = () =>
		workerJobRepository.claimNextBatch(
			{
				workerId,
				runnerId: `runner-${workerId}`,
				concurrency: CLAIM_CONCURRENCY,
				timeoutMs: 30_000,
				now: new Date(Date.now() + 60_000),
			},
			maxPerCall,
		);
	// Warm up statement compilation/JIT before timing.
	for (let index = 0; index < 3; index++) await claim();

	const timesMs: number[] = [];
	for (let call = 0; call < CLAIM_PROBES; call++) {
		const startedAt = performance.now();
		await claim();
		timesMs.push(performance.now() - startedAt);
	}

	clearBacklog(workerId);

	return { name: `claimNextBatch backlog=${backlog}`, timesMs };
}

const args = suiteArgs();

if (!args.help) {
	// The database is migrated here (not in a private factory) so the repository
	// singletons read it; `benchmark.ts` points ROOT_DIR at a fresh temp dir.
	console.log(`[workers] migrating isolated benchmark database (${process.env.DB_FILE_NAME ?? "reelvault.sqlite"})...`);
	databaseFactory.migrate();
	databaseFactory.analyze();

	console.log(`[workers] running worker repository benchmarks (${args.iterations} iterations)...`);

	bench(
		"Worker bulk enqueue (50 jobs/batch)",
		async () => {
			const batch = Array.from({ length: 50 }, () => enqueueInput(crypto.randomUUID()));

			return await workerJobRepository.enqueueMany(batch);
		},
		{ iterations: Math.min(args.iterations, 50) },
	);
	bench(
		"Worker dedupe lookup (findActiveByWorkerAndDedupeKeys)",
		async () => {
			const sampleKeys = Array.from({ length: 20 }, () => `dedupe-${crypto.randomUUID()}`);

			return await workerJobRepository.findActiveByWorkerAndDedupeKeys(WORKER_ID, sampleKeys);
		},
		{ iterations: args.iterations },
	);
	bench(
		"Worker batch claim (claimNextBatch 10 jobs)",
		async () => {
			return await workerJobRepository.claimNextBatch(
				{
					workerId: WORKER_ID,
					runnerId: "benchmark-runner",
					concurrency: 100,
					timeoutMs: 30_000,
					now: new Date(Date.now() + 60_000),
				},
				10,
			);
		},
		{ iterations: Math.min(args.iterations, 50) },
	);
	bench(
		"Worker list items (status + worker filter)",
		async () => {
			return await workerJobRepository.listItems(50, WORKER_ID, "running");
		},
		{ iterations: args.iterations },
	);

	// ─── Enqueue batch sizes ────────────────────────────────────────────────
	task("workers: enqueue cost by batch size", async () => {
		console.log("\n[workers] enqueue cost by batch size...");
		const enqueueSizes = [1, 10, 100, 1000];
		const enqueueResults: MicroBenchmarkResult[] = [];
		for (const size of enqueueSizes) {
			enqueueResults.push(
				await benchmarkAsync(
					`enqueueMany batch=${size}`,
					async () => {
						const batch = Array.from({ length: size }, () => enqueueInput(crypto.randomUUID(), `batch-${size}`));

						return await workerJobRepository.enqueueMany(batch);
					},
					{ iterations: size >= 100 ? 10 : args.iterations },
				),
			);
		}

		// A/B: the repository already inserts one multi-row statement per chunk; the
		// per-row path is the naive alternative this replaced.
		enqueueResults.push(
			await benchmarkAsync(
				"A/B enqueueMany batch=100 (multi-row)",
				async () => {
					const batch = Array.from({ length: 100 }, () => enqueueInput(crypto.randomUUID(), "ab-multi"));

					return await workerJobRepository.enqueueMany(batch);
				},
				{ iterations: 10 },
			),
		);
		enqueueResults.push(
			await benchmarkAsync(
				"A/B enqueue per-row (100 calls)",
				async () => {
					for (let index = 0; index < 100; index++) {
						await workerJobRepository.enqueueMany([enqueueInput(crypto.randomUUID(), "ab-single")]);
					}
				},
				{ iterations: 10 },
			),
		);
		printMicroResults(enqueueResults);
	});

	// ─── Claim cost vs backlog ──────────────────────────────────────────────
	task("workers: claim cost vs backlog", async () => {
		console.log("\n[workers] claimNextBatch cost vs pending backlog...");
		const claimResults: MicroBenchmarkResult[] = [];
		for (const backlog of BACKLOG_SIZES) {
			claimResults.push(await measureClaimAtBacklog(`backlog-${backlog}`, backlog, 10));
		}

		printTable(
			"claimNextBatch latency by backlog (10 jobs/claim)",
			["backlog", "p50", "p95", "p99", "max"],
			claimResults.map((result) => {
				const stats = summarizeLatencies(result.timesMs);

				return [
					result.name.replace("claimNextBatch backlog=", ""),
					fmtMs(stats.p50Ms),
					fmtMs(stats.p95Ms),
					fmtMs(stats.p99Ms),
					fmtMs(stats.maxMs),
				];
			}),
		);
	});

	// ─── Concurrent runners ─────────────────────────────────────────────────
	task("workers: claim contention (4 runners)", async () => {
		console.log("\n[workers] concurrent claim contention (4 runners)...");
		const contentionWorker = "contention";
		seedBacklog(contentionWorker, 5_000);
		const runners = 4;
		const startedAt = performance.now();
		const claimedPerRunner = await Promise.all(
			Array.from({ length: runners }, (_, runnerIndex) =>
				workerJobRepository.claimNextBatch(
					{
						workerId: contentionWorker,
						runnerId: `runner-${runnerIndex}`,
						concurrency: 10_000,
						timeoutMs: 30_000,
						now: new Date(Date.now() + 60_000),
					},
					50,
				),
			),
		);
		const contentionMs = performance.now() - startedAt;
		const totalClaimed = claimedPerRunner.reduce((total, claimed) => total + claimed.length, 0);
		clearBacklog(contentionWorker);
		const noDuplicates = new Set(claimedPerRunner.flat().map((job) => job.id)).size === totalClaimed;
		console.log(`  ${runners} runners claimed ${totalClaimed} jobs in ${fmtMs(contentionMs)} (no duplicate ids: ${noDuplicates})`);

		return { ok: noDuplicates, data: { runners, totalClaimed, noDuplicates } };
	});

	// ─── Retention purge ────────────────────────────────────────────────────
	task("workers: retention purge", async () => {
		console.log("\n[workers] retention purge (completed jobs)...");
		const purgeWorker = "purge";
		seedBacklog(purgeWorker, 5_000, "completed");
		const purgeResult = await benchmarkAsync(
			"purgeTerminalJobs (completed, cutoff now)",
			async () => await workerJobRepository.purgeTerminalJobs({ status: "completed", cutoffDate: new Date() }),
			{ warmup: 0, iterations: 5 },
		);
		clearBacklog(purgeWorker);
		printMicroResults([purgeResult]);
	});

	// ─── Runtime loop — runs the REAL worker runtime (pool + polling + registry +
	// watchdog) over a no-op handler: enqueue → claim → execute → complete, plus
	// single-job end-to-end latency. Started last because polling keeps running
	// afterwards.
	task("workers: runtime loop (bench-noop)", async () => {
		const { workerService } = await import("@/workers/worker.service");

		const BATCH = 100;
		const LATENCY_ROUNDS = 20;
		let completedCount = 0;
		const definition = {
			id: "bench-noop",
			concurrency: 2,
			timeoutMs: 30_000,
			attempts: 1,
			handler: () => {
				completedCount++;

				return Promise.resolve();
			},
		};

		await workerService.initialize([definition]);

		// ─── Batch throughput: enqueue BATCH jobs, wait for all completions ───
		const batchStartedAt = performance.now();
		await Promise.all(Array.from({ length: BATCH }, (_, index) => workerService.addItem("bench-noop", { round: index })));
		const enqueueMs = performance.now() - batchStartedAt;
		let done = 0;
		for (let waitedMs = 0; done < BATCH && waitedMs < 30_000; waitedMs += 10) {
			await sleep(10);
			done = completedCount;
		}

		const batchWallMs = performance.now() - batchStartedAt;

		printTable(
			`Runtime loop — batch of ${BATCH} no-op jobs (concurrency 2)`,
			["enqueue wall", "jobs/s end-to-end", "completed"],
			[[`${enqueueMs.toFixed(1)}ms`, (BATCH / (batchWallMs / 1000)).toFixed(1), String(completedCount)]],
		);

		// ─── Single-job end-to-end latency ───
		const latencies: number[] = [];
		for (let round = 0; round < LATENCY_ROUNDS; round++) {
			const before = completedCount;
			const startedAt = performance.now();
			await workerService.addItem("bench-noop", { round });
			let doneNow = completedCount;
			for (let waitedMs = 0; doneNow === before && waitedMs < 10_000; waitedMs += 5) {
				await sleep(5);
				doneNow = completedCount;
			}

			latencies.push(performance.now() - startedAt);
		}

		const stats = summarizeLatencies(latencies);
		printTable(
			"Runtime loop — single job enqueue→completion",
			["rounds", "p50", "p95", "max"],
			[[String(stats.count), fmtMs(stats.p50Ms), fmtMs(stats.p95Ms), fmtMs(stats.maxMs)]],
		);

		await workerService.shutdown();
	});
}

await main(import.meta);
