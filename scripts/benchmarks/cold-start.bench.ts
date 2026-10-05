import { bench, fmtMs, main, printTable, suiteArgs, summarizeLatencies, task, waitForHealth } from "benchkit";
import { spawn } from "bun";

import { type ManagedServer, repoRoot, serverEnv, startBenchmarkServer } from "./lib/server";

/**
 * Cold-start suite. Two views of startup cost:
 *  - provision+boot: migrate → seed → spawn → health → admin login, the full
 *    fixture lifecycle (baseline-tracked, catches seed/migration regressions);
 *  - boot-only: spawn → health against an ALREADY seeded database — the number
 *    a restarting user actually pays (warm DB, so OS caches settle).
 */

const BOOT_TIMEOUT_MS = 60_000;
const BOOT_ITERATIONS = 3;
const DEFAULT_COLD_START_ROWS = [1_000, 10_000];
/** Per-process base away from the shared 18472 default, so a leftover from a crashed run can't poison health checks. */
const PORT_BASE = 18600 + (process.pid % 300);

/** Sizes are env-overridable because seeding 100k rows in-process is minutes, not seconds. */
function coldStartRows(): number[] {
	const raw = process.env.COLD_START_ROWS;
	if (!raw) return DEFAULT_COLD_START_ROWS;

	const parsed = raw
		.split(",")
		.map((part) => Number.parseInt(part.trim(), 10))
		.filter((value) => Number.isInteger(value) && value > 0);

	return parsed.length > 0 ? parsed : DEFAULT_COLD_START_ROWS;
}

/** Spawns a second server process against the SAME seeded data dir and times spawn → health. */
async function bootOnce(managed: ManagedServer, port: number): Promise<number> {
	const startedAt = performance.now();
	const child = spawn(["bun", "run", "src/index.ts"], {
		cwd: repoRoot,
		env: serverEnv(port, managed.rootDir),
		stdout: "pipe",
		stderr: "pipe",
	});
	try {
		await waitForHealth(`http://127.0.0.1:${port}/v1/health`, { timeoutMs: BOOT_TIMEOUT_MS, pollMs: 50 });

		return performance.now() - startedAt;
	} catch (error) {
		// The child's own output is the only window into a failed boot — surface it.
		const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
		console.error(`[cold-start] boot on :${port} failed — stdout:\n${out.slice(-2000)}\nstderr:\n${err.slice(-2000)}`);
		throw error;
	} finally {
		child.kill();
		await child.exited;
	}
}

export const meta = { description: "Cold start (provision+boot lifecycle, boot-only restart against seeded DB)" };

/** Registers both cold-start units for one row count (factory keeps closures out of the loop). */
function registerColdStartUnits(size: number, nextPort: () => number, keepServer: boolean): void {
	bench(
		`cold provision+boot @ ${size} rows`,
		async () => {
			const managed = await startBenchmarkServer({ seedRows: size, workerCount: 1, port: nextPort() });
			await managed.stop();
		},
		{ iterations: 2 },
	);

	task(`cold-start: boot-only @ ${size} rows`, async () => {
		const port = nextPort();
		const managed = await startBenchmarkServer({ seedRows: size, workerCount: 1, port });
		try {
			// One throwaway boot settles page-cache/disk effects so the measured
			// boots reflect steady-state restarts, not the first-touch cost.
			await bootOnce(managed, port + 100);

			const times: number[] = [];
			for (let attempt = 0; attempt < BOOT_ITERATIONS; attempt++) {
				times.push(await bootOnce(managed, port + 101 + attempt));
			}

			const stats = summarizeLatencies(times);
			printTable(
				`Cold boot-only (spawn → health, warm DB) @ ${size} rows`,
				["samples", "p50", "p95", "max"],
				[[String(stats.count), fmtMs(stats.p50Ms), fmtMs(stats.p95Ms), fmtMs(stats.maxMs)]],
			);
		} finally {
			if (!keepServer) await managed.stop();
		}
	});
}

const args = suiteArgs();

if (!args.help) {
	// The runner's probe invocation is NOT awaited (it only sniffs sync/async),
	// so it races the first measured call — every invocation takes the next
	// unused port, making concurrent fixtures independent by construction.
	let portCursor = PORT_BASE;
	const nextPort = (): number => portCursor++;

	for (const size of coldStartRows()) {
		registerColdStartUnits(size, nextPort, args.keepServer);
	}
}

await main(import.meta);
