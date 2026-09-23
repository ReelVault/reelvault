import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WorkerDefinition } from "@reelvault/sdk/common";
import { MINUTE } from "@/server.constants";
import { setWorkerRuntime } from "./worker-runtime";
import { createMockWorkerItem, createMockWorkerRuntime } from "./worker-runtime.test-utils";
import { WorkerSchedulerService } from "./worker-scheduler.service";

/** Replaces a method on the live singleton for one test, recording calls.
 * Works on real repositories AND on the minimal facades other test files
 * install with bun's process-global mock.module(...). */
function stubMethod(target: object, method: string, impl: (...args: never[]) => unknown): { calls: unknown[][]; restore(): void } {
	const original = Reflect.get(target, method);
	const calls: unknown[][] = [];
	Reflect.set(target, method, (...args: never[]) => {
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

// Anchor chosen away from daily-trigger times and on a clean interval boundary
// (epoch minute 3_000_000 is divisible by 30, 10, 15, 60).
const ANCHOR_MINUTE = 3_000_000;
const ANCHOR = new Date(ANCHOR_MINUTE * MINUTE);

function def(id: string, overrides: Partial<WorkerDefinition> = {}): WorkerDefinition {
	return {
		id,
		handler: async () => undefined,
		defaultTriggers: [],
		...overrides,
	};
}

let defs: WorkerDefinition[] = [];
/** Simulated persistence for the scheduler's deadlines (getAllSchedules/setNextRunAt stubs). */
const scheduleRows = new Map<string, { workerId: string; triggers: unknown[]; isEnabled: boolean; nextRunAt?: Date }>();
const nextRunAtCalls: Array<{ workerId: string; nextRunAt: Date | null }> = [];
const enqueued: Array<{ workerId: string; dedupeKey: string }> = [];
const operationRemovals: string[] = [];
let manualActiveJob: { id: string } | undefined;
let enqueueError: Error | undefined;

const activeStubs: Array<{ restore(): void }> = [];

beforeEach(async () => {
	defs = [];
	scheduleRows.clear();
	nextRunAtCalls.length = 0;
	enqueued.length = 0;
	operationRemovals.length = 0;
	manualActiveJob = undefined;
	enqueueError = undefined;

	setWorkerRuntime(
		createMockWorkerRuntime({
			registry: {
				getAll: () => defs,
				get: (id: string) => defs.find((d) => d.id === id),
				has: (id: string) => defs.some((d) => d.id === id),
			},
			pool: {
				cancelAllForWorker: () => 0,
			},
			queue: {
				enqueue: (workerId, _data, options) => {
					if (enqueueError) throw enqueueError;

					enqueued.push({ workerId, dedupeKey: options?.dedupeKey ?? "" });

					return Promise.resolve(createMockWorkerItem({ id: "job-1" }));
				},
				findActive: () => Promise.resolve(manualActiveJob ? createMockWorkerItem(manualActiveJob) : undefined),
				cancelAllPending: () => Promise.resolve(0),
			},
		}),
	);

	const schedules = await import("@/database/repositories/worker-schedules.repository");
	const schedulesRepo = schedules.workerSchedulesRepository;
	activeStubs.push(
		stubMethod(schedulesRepo, "getAllTriggers", () => Promise.resolve(new Map())),
		stubMethod(schedulesRepo, "setTriggers", () => Promise.resolve()),
		stubMethod(schedulesRepo, "getAllSchedules", () => Promise.resolve(new Map(scheduleRows))),
		stubMethod(schedulesRepo, "setNextRunAt", (workerId: string, nextRunAt: Date | null) => {
			nextRunAtCalls.push({ workerId, nextRunAt });
			if (!nextRunAt) return Promise.resolve();

			const row = scheduleRows.get(workerId) ?? { workerId, triggers: [], isEnabled: true };
			scheduleRows.set(workerId, { ...row, nextRunAt });

			return Promise.resolve();
		}),
	);

	const workerRepo = await import("@/database/repositories/worker.repository");
	activeStubs.push(stubMethod(workerRepo.workerJobRepository, "getStats", () => Promise.resolve([])));

	const operations = await import("./worker-operations.service");
	activeStubs.push(
		stubMethod(operations.workerOperationsService, "create", () => Promise.resolve({ id: "op-1" })),
		stubMethod(operations.workerOperationsService, "remove", (id: string) => {
			operationRemovals.push(id);

			return Promise.resolve(undefined);
		}),
	);
});

afterEach(() => {
	for (const stub of activeStubs.splice(0)) stub.restore();
});

describe("WorkerSchedulerService.evaluateTriggers", () => {
	test("fires startup triggers once on the first evaluation", async () => {
		defs = [def("w-startup", { defaultTriggers: [{ id: "t1", type: "startup" }] }), def("w-plain")];

		const scheduler = new WorkerSchedulerService();
		await scheduler.evaluateTriggers(ANCHOR);

		expect(enqueued).toEqual([{ workerId: "w-startup", dedupeKey: `startup:${ANCHOR_MINUTE}` }]);

		// A later minute must not re-fire the startup trigger.
		await scheduler.evaluateTriggers(new Date((ANCHOR_MINUTE + 1) * MINUTE));
		expect(enqueued).toHaveLength(1);
	});

	test("arms a deadline on first sight without firing immediately", async () => {
		defs = [def("w-daily", { defaultTriggers: [{ id: "t2", type: "daily", timeOfDay: timeOfDayAt(ANCHOR_MINUTE + 3) }] })];

		const scheduler = new WorkerSchedulerService();
		await scheduler.evaluateTriggers(ANCHOR);
		expect(enqueued).toHaveLength(0);
		// The deadline was persisted (initialization), not yet consumed.
		expect(nextRunAtCalls).toContainEqual({ workerId: "w-daily", nextRunAt: expect.any(Date) });
	});

	test("fires an overdue persisted deadline exactly once after downtime", async () => {
		defs = [def("w-interval", { defaultTriggers: [{ id: "t3", type: "interval", intervalMinutes: 30 }] })];
		// Deadline from before a long outage — well past due at the anchor.
		const overdue = new Date((ANCHOR_MINUTE - 60) * MINUTE);
		scheduleRows.set("w-interval", { workerId: "w-interval", triggers: [], isEnabled: true, nextRunAt: overdue });

		const scheduler = new WorkerSchedulerService();
		await scheduler.evaluateTriggers(ANCHOR);

		// Exactly one catch-up run (no minute replay flood), then the deadline
		// advanced past `now`.
		expect(enqueued).toEqual([{ workerId: "w-interval", dedupeKey: `schedule:w-interval:${overdue.getTime()}` }]);
		const advanced = nextRunAtCalls.at(-1);
		expect(advanced?.workerId).toBe("w-interval");
		expect(advanced?.nextRunAt?.getTime()).toBeGreaterThan(ANCHOR.getTime());
	});

	test("fires the due minute once and not twice within it", async () => {
		defs = [def("w-interval", { defaultTriggers: [{ id: "t4", type: "interval", intervalMinutes: 30 }] })];

		const scheduler = new WorkerSchedulerService();
		// First evaluation arms the deadline (next 30-minute boundary = the anchor).
		await scheduler.evaluateTriggers(new Date((ANCHOR_MINUTE - 1) * MINUTE));
		await scheduler.evaluateTriggers(ANCHOR);
		await scheduler.evaluateTriggers(ANCHOR);
		await scheduler.evaluateTriggers(new Date(ANCHOR.getTime() + 20_000)); // same minute, 20 s later

		expect(enqueued).toEqual([{ workerId: "w-interval", dedupeKey: `schedule:w-interval:${ANCHOR_MINUTE * MINUTE}` }]);
	});
});

describe("WorkerSchedulerService trigger management", () => {
	test("custom triggers override the definition defaults", async () => {
		defs = [def("w-x", { defaultTriggers: [{ id: "t5", type: "startup" }] })];
		const scheduler = new WorkerSchedulerService();

		await scheduler.updateWorkerTriggers("w-x", [{ id: "c1", type: "daily", timeOfDay: "04:30" }]);
		expect(scheduler.getTriggersForWorker("w-x")).toEqual([{ id: "c1", type: "daily", timeOfDay: "04:30" }]);
		// Trigger changes recompute the persisted deadline for the new trigger set.
		expect(nextRunAtCalls.at(-1)?.workerId).toBe("w-x");
		expect(nextRunAtCalls.at(-1)?.nextRunAt).toBeInstanceOf(Date);

		// The custom trigger replaced the startup default — no startup firing anymore.
		await scheduler.evaluateTriggers(ANCHOR);
		expect(enqueued).toHaveLength(0);
	});

	test("updateWorkerTriggers validates trigger shapes before persisting", async () => {
		defs = [def("w-y")];
		const schedules = await import("@/database/repositories/worker-schedules.repository");
		const schedulesRepo = schedules.workerSchedulesRepository;
		const persist = stubMethod(schedulesRepo, "setTriggers", () => Promise.resolve());
		activeStubs.push(persist);
		const scheduler = new WorkerSchedulerService();

		await expect(scheduler.updateWorkerTriggers("w-y", [{ id: "bad", type: "daily" }])).rejects.toThrow("timeOfDay");
		await expect(scheduler.updateWorkerTriggers("w-y", [{ id: "bad", type: "weekly", timeOfDay: "04:30", dayOfWeek: 7 }])).rejects.toThrow(
			"dayOfWeek",
		);
		await expect(scheduler.updateWorkerTriggers("w-y", [{ id: "bad", type: "interval", intervalMinutes: 0 }])).rejects.toThrow(
			"intervalMinutes",
		);
		await expect(scheduler.updateWorkerTriggers("missing", [])).rejects.toThrow('Worker "missing" was not found');

		expect(persist.calls).toHaveLength(0);

		await scheduler.updateWorkerTriggers("w-y", [{ id: "ok", type: "interval", intervalMinutes: 15 }]);
		expect(persist.calls[0]?.[0]).toBe("w-y");
		expect(scheduler.getTriggersForWorker("w-y")).toEqual([{ id: "ok", type: "interval", intervalMinutes: 15 }]);
	});
});

describe("WorkerSchedulerService.runWorkerManually", () => {
	test("enqueues with manual dedupe key and high priority", async () => {
		defs = [def("w-manual")];
		const scheduler = new WorkerSchedulerService();

		const result = await scheduler.runWorkerManually("w-manual", { force: true });

		expect(result).toMatchObject({ success: true, jobId: "job-1", operationId: "op-1" });
	});

	test("rejects a second manual run while one is active", async () => {
		defs = [def("w-manual")];
		manualActiveJob = { id: "active-1" };

		const scheduler = new WorkerSchedulerService();
		await expect(scheduler.runWorkerManually("w-manual")).rejects.toThrow("already has a pending or running manual task");
	});

	test("cleans up the operation when the enqueue is rejected", async () => {
		defs = [def("w-manual")];
		enqueueError = new Error("queue down");

		const scheduler = new WorkerSchedulerService();
		await expect(scheduler.runWorkerManually("w-manual")).rejects.toThrow("queue down");
		expect(operationRemovals).toEqual(["op-1"]);
	});
});

describe("WorkerSchedulerService.runWorkerCategoryManually", () => {
	test("runs every member of the category and skips workers with an active manual task", async () => {
		defs = [
			def("w-b", { category: "database_optimization" }),
			def("w-a", { category: "database_optimization" }),
			def("w-other", { category: "system" }),
			def("w-busy", { category: "database_optimization" }),
		];
		manualActiveJob = { id: "active-1" }; // dedupe hit for every manual run

		const scheduler = new WorkerSchedulerService();
		const result = await scheduler.runWorkerCategoryManually("database_optimization");

		// Sorted deterministically, category-filtered, and each busy member skipped.
		expect(result).toEqual({
			success: true,
			started: [],
			skipped: [
				{ workerId: "w-a", reason: "already_pending_or_running" },
				{ workerId: "w-b", reason: "already_pending_or_running" },
				{ workerId: "w-busy", reason: "already_pending_or_running" },
			],
		});

		manualActiveJob = undefined;
		const second = await scheduler.runWorkerCategoryManually("database_optimization");
		expect(second.started.map((s) => s.workerId)).toEqual(["w-a", "w-b", "w-busy"]);
		expect(second.skipped).toEqual([]);
		expect(enqueued.map((e) => e.dedupeKey)).toEqual(["manual:w-a", "manual:w-b", "manual:w-busy"]);
	});

	test("returns an empty result for a category without registered members", async () => {
		defs = [def("w-plain")];
		const scheduler = new WorkerSchedulerService();

		const result = await scheduler.runWorkerCategoryManually("file_cleanup");

		expect(result).toEqual({ success: true, started: [], skipped: [] });
	});
});

describe("WorkerSchedulerService.listWorkerSummaries", () => {
	test("merges definitions, live stats and last execution info", async () => {
		defs = [def("w-sum", { name: "Summarized", concurrency: 3, timeoutMs: 5_000 })];
		const workerRepo = await import("@/database/repositories/worker.repository");
		const statsStub = stubMethod(workerRepo.workerJobRepository, "getStats", () =>
			Promise.resolve([
				{ workerId: "w-sum", status: "pending", count: 2 },
				{ workerId: "w-sum", status: "running", count: 1 },
				{ workerId: "w-sum", status: "completed", count: 10 },
				{ workerId: "w-sum", status: "failed", count: 1 },
			]),
		);
		const schedules = await import("@/database/repositories/worker-schedules.repository");
		const allSchedules = stubMethod(schedules.workerSchedulesRepository, "getAllSchedules", () =>
			Promise.resolve(
				new Map([
					[
						"w-sum",
						{
							workerId: "w-sum",
							lastRunAt: new Date("2026-01-01T00:00:00.000Z"),
							lastStatus: "completed",
							lastCompletedAt: new Date("2026-01-01T00:01:00.000Z"),
							lastDurationMs: 60_000,
						},
					],
				]),
			),
		);
		activeStubs.push(statsStub, allSchedules);

		const scheduler = new WorkerSchedulerService();
		const summaries = await scheduler.listWorkerSummaries();

		expect(summaries).toHaveLength(1);
		expect(summaries[0]).toMatchObject({
			id: "w-sum",
			name: "Summarized",
			concurrency: 3,
			timeoutMs: 5_000,
			stats: { waiting: 2, active: 1, completed: 10, failed: 1 },
			lastExecution: {
				startedAt: "2026-01-01T00:00:00.000Z",
				status: "completed",
				completedAt: "2026-01-01T00:01:00.000Z",
				durationMs: 60_000,
			},
		});
	});
});

/** HH:MM of the given epoch minute in the machine's local time — the daily
 * trigger matches local wall-clock hours, so the fixture must be built in the
 * same zone the code under test reads. */
function timeOfDayAt(minute: number): string {
	const at = new Date(minute * MINUTE);

	return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}
