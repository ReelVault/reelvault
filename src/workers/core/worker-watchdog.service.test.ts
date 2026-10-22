import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { workerJobRepository } from "@/repositories/worker.repository";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { setWorkerRuntime } from "./worker.runtime";
import { createMockWorkerRuntime, restoreWorkerRuntime } from "./worker-runtime.helper";
import { WorkerWatchdogService } from "./worker-watchdog.service";

// Orphan recovery runs against the migrated test database.
useTestDatabase();

const WORKER_ID = "watchdog-test";
const HOUR_MS = 60 * 60 * 1000;

const activeJobIds: string[] = [];

function installRuntime(getActiveJobIds: () => string[] = () => [...activeJobIds]): void {
	setWorkerRuntime(
		createMockWorkerRuntime({
			pool: { getActiveJobIds },
		}),
	);
}

/**
 * Seeds one running job per id, each claimed by a runner whose lease ended an hour ago —
 * the state a crashed runner leaves behind. Jobs have attempts left, so recovery requeues them.
 */
async function seedOrphanedJobs(ids: string[]): Promise<void> {
	for (const id of ids) {
		await workerJobRepository.enqueue({
			id,
			workerId: WORKER_ID,
			data: "{}",
			priority: 0,
			maxAttempts: 3,
			backoffType: "fixed",
			backoffDelayMs: 1_000,
			runAt: new Date(0),
		});
	}

	await workerJobRepository.claimNextBatch(
		{ workerId: WORKER_ID, runnerId: "dead-runner", concurrency: ids.length, timeoutMs: 1_000, now: new Date(Date.now() - HOUR_MS) },
		ids.length,
	);
}

beforeEach(() => {
	installRuntime();
	activeJobIds.length = 0;
});

function createWatchdog(lastPollAt: number, callbacks: { stall?: () => void; escalated?: () => void } = {}): WorkerWatchdogService {
	const watchdog = new WorkerWatchdogService();
	watchdog.registerPolling({
		getLastPollAt: () => lastPollAt,
		onStallDetected: () => callbacks.stall?.(),
		onEscalated: () => callbacks.escalated?.(),
	});

	return watchdog;
}

/** `checkHealth` is private and driven by the watchdog's timer; tests call it directly. */
function checkHealth(watchdog: WorkerWatchdogService): void {
	Reflect.apply(Reflect.get(watchdog, "checkHealth"), watchdog, []);
}

describe("WorkerWatchdogService.checkHealth", () => {
	test("a fresh poll resets the failure streak and detects nothing", () => {
		const stalls: number[] = [];
		const watchdog = createWatchdog(Date.now(), { stall: () => stalls.push(1) });

		checkHealth(watchdog);
		checkHealth(watchdog);

		expect(stalls).toHaveLength(0);
		expect(watchdog.getState().consecutiveFailures).toBe(0);
	});

	test("stalled polling nudges the poller and escalates after three consecutive stalls", () => {
		const stalls: number[] = [];
		let escalations = 0;
		// Last poll far beyond any scaled threshold (≤ 2 × 15 s).
		const watchdog = createWatchdog(Date.now() - 120_000, {
			stall: () => stalls.push(stalls.length + 1),
			escalated: () => {
				escalations += 1;
			},
		});

		checkHealth(watchdog);
		checkHealth(watchdog);
		checkHealth(watchdog);
		expect(stalls).toEqual([1, 2, 3]);
		expect(escalations).toBe(1);
		expect(watchdog.getState().consecutiveFailures).toBe(3);

		// A 4th stall nudges but does not re-escalate.
		checkHealth(watchdog);
		expect(stalls).toEqual([1, 2, 3, 4]);
		expect(escalations).toBe(1);
	});

	test("a recovered poll resets the streak, so escalation needs 3 fresh stalls", () => {
		let lastPollAt = Date.now() - 120_000;
		const watchdog = new WorkerWatchdogService();
		watchdog.registerPolling({
			getLastPollAt: () => lastPollAt,
			onStallDetected: () => {
				// intentionally empty
			},
			onEscalated: () => {
				// intentionally empty
			},
		});

		checkHealth(watchdog);
		checkHealth(watchdog);
		expect(watchdog.getState().consecutiveFailures).toBe(2);

		// Poller recovered.
		lastPollAt = Date.now();
		checkHealth(watchdog);
		expect(watchdog.getState().consecutiveFailures).toBe(0);

		// Streak restarts from zero — two stalls are not enough to escalate.
		lastPollAt = Date.now() - 120_000;
		checkHealth(watchdog);
		checkHealth(watchdog);
		expect(watchdog.getState().consecutiveFailures).toBe(2);
	});

	test("getState exposes lastPollAt and the running flag", () => {
		const watchdog = createWatchdog(1_700_000_000_000);
		const state = watchdog.getState();

		expect(state.running).toBe(false);
		expect(state.lastPollAt).toBe("2023-11-14T22:13:20.000Z");
	});
});

describe("WorkerWatchdogService recovery visibility", () => {
	test("getState counts the orphaned jobs requeued since start and dates the latest pass", async () => {
		// Pinned so the dead runner's lease has ended and the pass is dated to a known instant.
		setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
		await seedOrphanedJobs([Bun.randomUUIDv7(), Bun.randomUUIDv7(), Bun.randomUUIDv7()]);
		const watchdog = new WorkerWatchdogService();

		expect(watchdog.getState()).toMatchObject({ recoveredJobs: 0 });
		expect(watchdog.getState().lastRecoveredAt).toBeUndefined();

		expect(await watchdog.recoverOrphaned()).toBe(3);
		expect(watchdog.getState()).toMatchObject({ recoveredJobs: 3, lastRecoveredAt: "2026-01-01T00:00:00.000Z" });
	});

	test("an empty pass leaves the counters untouched", async () => {
		const watchdog = new WorkerWatchdogService();

		expect(await watchdog.recoverOrphaned()).toBe(0);
		expect(watchdog.getState()).toMatchObject({ recoveredJobs: 0 });
		expect(watchdog.getState().lastRecoveredAt).toBeUndefined();
	});
});

describe("WorkerWatchdogService.recoverOrphaned", () => {
	test("excludes jobs still claimed by the live pool", async () => {
		const live = Bun.randomUUIDv7();
		const orphan = Bun.randomUUIDv7();
		await seedOrphanedJobs([live, orphan]);
		activeJobIds.push(live);
		const watchdog = new WorkerWatchdogService();

		expect(await watchdog.recoverOrphaned()).toBe(1);
		expect(await workerJobRepository.findItem(live)).toMatchObject({ status: "running" });
		expect(await workerJobRepository.findItem(orphan)).toMatchObject({ status: "pending" });
	});

	test("a failed pass requeues nothing and returns zero", async () => {
		const orphans = [Bun.randomUUIDv7(), Bun.randomUUIDv7()];
		await seedOrphanedJobs(orphans);
		// The pool lookup fails before any repository call.
		installRuntime(() => {
			throw new Error("pool unavailable");
		});
		const watchdog = new WorkerWatchdogService();

		expect(await watchdog.recoverOrphaned()).toBe(0);
		for (const id of orphans) {
			expect(await workerJobRepository.findItem(id)).toMatchObject({ status: "running" });
		}
		expect(watchdog.getState()).toMatchObject({ recoveredJobs: 0 });
	});
});

afterEach(() => {
	setSystemTime();
	activeJobIds.length = 0;
	restoreWorkerRuntime();
});
