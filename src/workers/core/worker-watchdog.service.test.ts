import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setWorkerRuntime } from "./worker-runtime";
import { createMockWorkerRuntime } from "./worker-runtime.test-utils";
import { WorkerWatchdogService } from "./worker-watchdog.service";

const activeJobIds: string[] = [];

function installRuntime(): void {
	setWorkerRuntime(
		createMockWorkerRuntime({
			pool: { getActiveJobIds: () => [...activeJobIds] },
		}),
	);
}

/** Replaces a method on the live singleton for one test, recording calls.
 * Works on real repositories AND on the minimal facades other test files
 * install with bun's process-global mock.module(...). */
function stubMethod<TArgs extends unknown[]>(
	target: object,
	method: string,
	impl: (...args: TArgs) => unknown,
): { calls: TArgs[]; restore(): void } {
	const original = Reflect.get(target, method);
	const calls: TArgs[] = [];
	Reflect.set(target, method, (...args: TArgs) => {
		calls.push(args);

		return impl(...args);
	});

	return {
		calls,
		restore: () => {
			if (original === undefined) Reflect.deleteProperty(target, method);
			else Reflect.set(target, method, original);
		},
	};
}

let recoverCalls: unknown[][] = [];
let recoverResult: number | Error = 0;
const activeStubs: Array<{ restore(): void }> = [];

beforeEach(async () => {
	installRuntime();
	activeJobIds.length = 0;
	recoverCalls = [];
	recoverResult = 0;

	const { workerJobRepository } = await import("@/database/repositories/worker.repository");
	activeStubs.push(
		stubMethod(workerJobRepository, "recoverOrphanedRunning", (...args: unknown[]) => {
			recoverCalls.push(args);

			return recoverResult instanceof Error ? Promise.reject(recoverResult) : Promise.resolve(recoverResult);
		}),
	);
});

afterEach(() => {
	for (const stub of activeStubs.splice(0)) stub.restore();
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

function checkHealth(watchdog: WorkerWatchdogService): void {
	const fn = Reflect.get(watchdog, "checkHealth");
	if (typeof fn === "function") {
		Reflect.apply(fn, watchdog, []);
	}
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
		expect(state.lastPollAt).toBe(new Date(1_700_000_000_000).toISOString());
	});
});

describe("WorkerWatchdogService.recoverOrphaned", () => {
	test("excludes jobs still claimed by the live pool", async () => {
		activeJobIds.push("job-live-1", "job-live-2");
		recoverResult = 4;
		const watchdog = new WorkerWatchdogService();

		expect(await watchdog.recoverOrphaned()).toBe(4);
		expect(recoverCalls[0]?.[0]).toEqual({ excludeActiveIds: ["job-live-1", "job-live-2"] });
	});

	test("survives repository failures with a zero count", async () => {
		recoverResult = new Error("db down");
		const watchdog = new WorkerWatchdogService();

		expect(await watchdog.recoverOrphaned()).toBe(0);
	});
});
