import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WorkerDefinition } from "@reelvault/sdk/common";
import { MINUTE } from "@/config/server/server.constants";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { workerJobRepository } from "@/repositories/worker.repository";
import { workerSchedulesRepository } from "@/repositories/worker-schedules.repository";
import { stubMethod } from "../../../tests/helpers/method-stub.helper";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { setWorkerRuntime } from "./worker.runtime";
import { WorkerQueueService } from "./worker-queue.service";
import { createMockWorkerRuntime, restoreWorkerRuntime } from "./worker-runtime.helper";
import { WorkerSchedulerService } from "./worker-scheduler.service";

// Schedules, queued jobs, operations and last-run records run against the migrated test database.
// Worker definitions are fixtures injected through the runtime registry, and the pool (running
// worker threads) stays a no-op. Stubbed: the job stats aggregate, which is cached process-wide
// for 5 s with no invalidation, so a real read would return whatever ran last.
const db = useTestDatabase();

// Anchor chosen away from daily-trigger times and on a clean interval boundary
// (epoch minute 3_000_000 is divisible by 30, 10, 15, 60).
const ANCHOR_MINUTE = 3_000_000;
const ANCHOR = new Date(ANCHOR_MINUTE * MINUTE);

let defs: WorkerDefinition[] = [];
const activeStubs: Array<{ restore(): void }> = [];

function def(id: string, overrides: Partial<WorkerDefinition> = {}): WorkerDefinition {
	return {
		id,
		handler: async () => undefined,
		defaultTriggers: [],
		...overrides,
	};
}

/** Queued jobs as (worker, dedupe key), ordered by worker so assertions don't depend on insert order. */
async function queuedJobs(): Promise<Array<{ workerId: string; dedupeKey: string | null }>> {
	const rows = await db.client().select().from(schema.workerJobs);

	return rows.map((job) => ({ workerId: job.workerId, dedupeKey: job.dedupeKey })).toSorted((a, b) => a.workerId.localeCompare(b.workerId));
}

async function nextRunOf(workerId: string): Promise<Date | null | undefined> {
	return (await workerSchedulesRepository.getSchedule(workerId))?.nextRunAt;
}

beforeEach(() => {
	defs = [];
	setWorkerRuntime({
		...createMockWorkerRuntime({
			registry: {
				getAll: () => defs,
				get: (id: string) => defs.find((d) => d.id === id),
				has: (id: string) => defs.some((d) => d.id === id),
			},
		}),
		queue: new WorkerQueueService(),
	});
});

afterEach(() => {
	for (const stub of activeStubs.splice(0).toReversed()) stub.restore();
	restoreWorkerRuntime();
});

describe("WorkerSchedulerService.evaluateTriggers", () => {
	test("fires a startup trigger once, on the first evaluation", async () => {
		defs = [def("w-startup", { defaultTriggers: [{ id: "t1", type: "startup" }] }), def("w-plain")];

		const scheduler = new WorkerSchedulerService();
		await scheduler.evaluateTriggers(ANCHOR);

		expect(await queuedJobs()).toEqual([{ workerId: "w-startup", dedupeKey: `startup:${ANCHOR_MINUTE}` }]);

		// A later minute must not re-fire the startup trigger.
		await scheduler.evaluateTriggers(new Date((ANCHOR_MINUTE + 1) * MINUTE));
		expect(await queuedJobs()).toHaveLength(1);
	});

	test("arms a deadline on first sight without firing it", async () => {
		defs = [def("w-daily", { defaultTriggers: [{ id: "t2", type: "daily", timeOfDay: timeOfDayAt(ANCHOR_MINUTE + 3) }] })];

		await new WorkerSchedulerService().evaluateTriggers(ANCHOR);

		expect(await queuedJobs()).toEqual([]);
		expect(await nextRunOf("w-daily")).toEqual(new Date((ANCHOR_MINUTE + 3) * MINUTE));
	});

	test("fires an overdue deadline once after downtime and re-arms it past now", async () => {
		defs = [def("w-interval", { defaultTriggers: [{ id: "t3", type: "interval", intervalMinutes: 30 }] })];
		// Deadline from before a long outage — well past due at the anchor.
		const overdue = new Date((ANCHOR_MINUTE - 60) * MINUTE);
		await workerSchedulesRepository.setNextRunAt("w-interval", overdue);

		await new WorkerSchedulerService().evaluateTriggers(ANCHOR);

		// Exactly one catch-up run (no minute replay flood), then the next boundary after `now`.
		expect(await queuedJobs()).toEqual([{ workerId: "w-interval", dedupeKey: `schedule:w-interval:${overdue.getTime()}` }]);
		expect(await nextRunOf("w-interval")).toEqual(new Date((ANCHOR_MINUTE + 30) * MINUTE));
	});

	test("a schedule whose payload cannot be stored keeps its deadline due for the next tick", async () => {
		// A payload that cannot be serialized makes the real enqueue reject.
		defs = [def("w-broken", { schedule: { cron: "0 4 * * *", data: { attempt: 1n } } })];
		const overdue = new Date((ANCHOR_MINUTE - 60) * MINUTE);
		await workerSchedulesRepository.setNextRunAt("w-broken", overdue);

		await new WorkerSchedulerService().evaluateTriggers(ANCHOR);

		// Nothing was queued and the deadline was not advanced, so the next tick retries.
		expect(await queuedJobs()).toEqual([]);
		expect(await nextRunOf("w-broken")).toEqual(overdue);
	});

	test("a worker without triggers gets no deadline and no schedule row", async () => {
		defs = [def("w-plain")];

		const scheduler = new WorkerSchedulerService();
		await scheduler.evaluateTriggers(ANCHOR);
		await scheduler.evaluateTriggers(new Date((ANCHOR_MINUTE + 1) * MINUTE));

		expect(await workerSchedulesRepository.getSchedule("w-plain")).toBeUndefined();
		expect(await queuedJobs()).toEqual([]);
	});

	test("fires the due minute once, however often the pass runs within it", async () => {
		defs = [def("w-interval", { defaultTriggers: [{ id: "t4", type: "interval", intervalMinutes: 30 }] })];

		const scheduler = new WorkerSchedulerService();
		// First evaluation arms the deadline (next 30-minute boundary = the anchor).
		await scheduler.evaluateTriggers(new Date((ANCHOR_MINUTE - 1) * MINUTE));
		await scheduler.evaluateTriggers(ANCHOR);
		await scheduler.evaluateTriggers(ANCHOR);
		await scheduler.evaluateTriggers(new Date(ANCHOR.getTime() + 20_000)); // same minute, 20 s later

		expect(await queuedJobs()).toEqual([{ workerId: "w-interval", dedupeKey: `schedule:w-interval:${ANCHOR.getTime()}` }]);
	});
});

describe("WorkerSchedulerService pause and resume", () => {
	test("a paused worker fires neither its startup trigger nor an overdue deadline", async () => {
		defs = [def("w-paused", { defaultTriggers: [{ id: "t4", type: "startup" }] })];
		await workerSchedulesRepository.setEnabled("w-paused", false);
		await workerSchedulesRepository.setNextRunAt("w-paused", new Date((ANCHOR_MINUTE - 60) * MINUTE));

		await new WorkerSchedulerService().evaluateTriggers(ANCHOR);

		expect(await queuedJobs()).toEqual([]);
	});

	test("resuming re-arms the deadline from now instead of replaying the paused period", async () => {
		defs = [def("w-resumed", { defaultTriggers: [{ id: "t5", type: "interval", intervalMinutes: 30 }] })];
		await workerSchedulesRepository.setEnabled("w-resumed", false);
		await workerSchedulesRepository.setNextRunAt("w-resumed", new Date(0));

		const before = Date.now();
		const state = await new WorkerSchedulerService().setScheduleEnabled("w-resumed", true);

		// The new deadline is the next interval boundary after now, not the stale one from the paused period.
		const resumedAt = Date.parse(state.nextRunAt ?? "");
		expect(state).toMatchObject({ workerId: "w-resumed", enabled: true });
		expect(resumedAt).toBeGreaterThan(before);
		expect(resumedAt).toBeLessThanOrEqual(before + 30 * MINUTE);
		expect((await nextRunOf("w-resumed"))?.getTime()).toBe(resumedAt);
		expect(await queuedJobs()).toEqual([]);
	});

	test("pausing stores the flag and reports no next run", async () => {
		defs = [def("w-off")];

		const state = await new WorkerSchedulerService().setScheduleEnabled("w-off", false);

		expect(state).toEqual({ workerId: "w-off", enabled: false, nextRunAt: null });
		expect((await workerSchedulesRepository.getSchedule("w-off"))?.isEnabled).toBe(false);
	});

	test("an unknown worker cannot be paused", async () => {
		await expect(new WorkerSchedulerService().setScheduleEnabled("missing", false)).rejects.toMatchObject({ code: "worker.not_found" });
	});

	test("paused workers summarise without a next run", async () => {
		defs = [def("w-off-summary"), def("w-on-summary", { defaultTriggers: [{ id: "t6", type: "interval", intervalMinutes: 30 }] })];
		await workerSchedulesRepository.setEnabled("w-off-summary", false);
		await workerSchedulesRepository.setNextRunAt("w-off-summary", ANCHOR);
		await workerSchedulesRepository.setNextRunAt("w-on-summary", ANCHOR);

		const summaries = await new WorkerSchedulerService().listWorkerSummaries();
		const byId = new Map(summaries.map((summary) => [summary.id, summary]));

		expect(byId.get("w-off-summary")).toMatchObject({ scheduleEnabled: false });
		expect(byId.get("w-off-summary")).not.toHaveProperty("nextRunAt");
		expect(byId.get("w-on-summary")).toMatchObject({ scheduleEnabled: true, nextRunAt: ANCHOR.toISOString() });
	});
});

describe("WorkerSchedulerService trigger management", () => {
	test("custom triggers replace the definition defaults and re-arm the deadline", async () => {
		defs = [def("w-x", { defaultTriggers: [{ id: "t5", type: "startup" }] })];
		const scheduler = new WorkerSchedulerService();

		await scheduler.updateWorkerTriggers("w-x", [{ id: "c1", type: "daily", timeOfDay: "04:30" }]);
		expect(scheduler.getTriggersForWorker("w-x")).toEqual([{ id: "c1", type: "daily", timeOfDay: "04:30" }]);

		// The stored deadline is the next local 04:30, which is in the future.
		const armed = await nextRunOf("w-x");
		expect([armed?.getHours(), armed?.getMinutes()]).toEqual([4, 30]);
		expect(armed?.getTime()).toBeGreaterThan(Date.now());

		// The custom trigger replaced the startup default — no startup firing anymore.
		await scheduler.evaluateTriggers(ANCHOR);
		expect(await queuedJobs()).toEqual([]);
	});

	test("updateWorkerTriggers refuses malformed triggers and stores none of them", async () => {
		defs = [def("w-y")];
		const scheduler = new WorkerSchedulerService();

		await expect(scheduler.updateWorkerTriggers("w-y", [{ id: "bad", type: "daily" }])).rejects.toMatchObject({
			code: "worker.schedule_time_invalid",
		});
		await expect(
			scheduler.updateWorkerTriggers("w-y", [{ id: "bad", type: "weekly", timeOfDay: "04:30", dayOfWeek: 7 }]),
		).rejects.toMatchObject({ code: "worker.schedule_day_invalid" });
		await expect(scheduler.updateWorkerTriggers("w-y", [{ id: "bad", type: "interval", intervalMinutes: 0 }])).rejects.toMatchObject({
			code: "worker.schedule_interval_invalid",
		});
		await expect(scheduler.updateWorkerTriggers("missing", [])).rejects.toMatchObject({ code: "worker.not_found" });

		expect(await workerSchedulesRepository.getSchedule("w-y")).toBeUndefined();

		await scheduler.updateWorkerTriggers("w-y", [{ id: "ok", type: "interval", intervalMinutes: 15 }]);
		expect((await workerSchedulesRepository.getSchedule("w-y"))?.triggers).toEqual([{ id: "ok", type: "interval", intervalMinutes: 15 }]);
		expect(scheduler.getTriggersForWorker("w-y")).toEqual([{ id: "ok", type: "interval", intervalMinutes: 15 }]);
	});
});

describe("WorkerSchedulerService.runWorkerManually", () => {
	test("enqueues a manual run under the manual dedupe key at the highest priority", async () => {
		defs = [def("w-manual")];

		const result = await new WorkerSchedulerService().runWorkerManually("w-manual", { force: true });

		const [job] = await db.client().select().from(schema.workerJobs);
		expect(job).toMatchObject({
			id: result.jobId,
			workerId: "w-manual",
			dedupeKey: "manual:w-manual",
			priority: -10,
			status: "pending",
			operationId: result.operationId,
		});
		const operations = await db.client().select().from(schema.workerOperations);
		expect(operations).toEqual([expect.objectContaining({ id: result.operationId, type: "w-manual" })]);
	});

	test("rejects a second manual run while one is active", async () => {
		defs = [def("w-manual")];
		const scheduler = new WorkerSchedulerService();
		await scheduler.runWorkerManually("w-manual");

		await expect(scheduler.runWorkerManually("w-manual")).rejects.toMatchObject({
			category: "conflict",
			code: "worker.manual_task_active",
		});
		expect(await queuedJobs()).toHaveLength(1);
	});

	test("removes the operation when the payload cannot be stored", async () => {
		defs = [def("w-manual")];

		// A payload that cannot be serialized makes the real enqueue reject.
		await expect(new WorkerSchedulerService().runWorkerManually("w-manual", { attempt: 1n })).rejects.toBeInstanceOf(TypeError);

		expect(await queuedJobs()).toEqual([]);
		expect(await db.client().select().from(schema.workerOperations)).toEqual([]);
	});
});

describe("WorkerSchedulerService.runWorkerCategoryManually", () => {
	test("runs each category member without a pending manual task, in id order", async () => {
		defs = [
			def("w-b", { category: "database_optimization" }),
			def("w-a", { category: "database_optimization" }),
			def("w-other", { category: "system" }),
			def("w-busy", { category: "database_optimization" }),
		];
		const scheduler = new WorkerSchedulerService();
		await scheduler.runWorkerManually("w-busy");

		const result = await scheduler.runWorkerCategoryManually("database_optimization");

		// Sorted deterministically, category-filtered, and the busy member skipped.
		expect(result.started.map((entry) => entry.workerId)).toEqual(["w-a", "w-b"]);
		expect(result.skipped).toEqual([{ workerId: "w-busy", reason: "already_pending_or_running" }]);
		expect(await queuedJobs()).toEqual([
			{ workerId: "w-a", dedupeKey: "manual:w-a" },
			{ workerId: "w-b", dedupeKey: "manual:w-b" },
			{ workerId: "w-busy", dedupeKey: "manual:w-busy" },
		]);
	});

	test("returns an empty result for a category without registered members", async () => {
		defs = [def("w-plain")];

		const result = await new WorkerSchedulerService().runWorkerCategoryManually("file_cleanup");

		expect(result).toEqual({ success: true, started: [], skipped: [] });
	});
});

describe("WorkerSchedulerService.listWorkerSummaries", () => {
	test("merges definitions, live stats and last execution info", async () => {
		defs = [def("w-sum", { name: "Summarized", concurrency: 3, timeoutMs: 5_000 })];
		// Stats are a process-wide cached aggregate, so this test feeds the aggregate rows directly.
		activeStubs.push(
			stubMethod(workerJobRepository, "getStats", () =>
				Promise.resolve([
					{ workerId: "w-sum", status: "pending", count: 2 },
					{ workerId: "w-sum", status: "running", count: 1 },
					{ workerId: "w-sum", status: "completed", count: 10 },
					{ workerId: "w-sum", status: "failed", count: 1 },
				]),
			),
		);
		await workerSchedulesRepository.updateExecution("w-sum", {
			status: "completed",
			startedAt: new Date("2026-01-01T00:00:00.000Z"),
			completedAt: new Date("2026-01-01T00:01:00.000Z"),
			durationMs: 60_000,
		});

		const summaries = await new WorkerSchedulerService().listWorkerSummaries();

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
