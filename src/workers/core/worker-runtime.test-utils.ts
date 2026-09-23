import type { WorkerItem } from "@/database/repositories/worker.repository";
import type { WorkerRuntime, WorkerRuntimePool, WorkerRuntimeQueue, WorkerRuntimeRegistry } from "./worker-runtime";

/** Empty lookup result for the mock queue, which never persists items. */
const MOCK_FIND_NOTHING: WorkerItem | undefined = undefined;

export function createMockWorkerItem(overrides: Partial<WorkerItem> = {}): WorkerItem {
	return {
		id: "job-1",
		workerId: "test-worker",
		operationId: null,
		dependsOnJobId: null,
		dedupeKey: null,
		referenceType: null,
		referenceId: null,
		data: "{}",
		status: "pending",
		progressPercent: null,
		priority: 0,
		attempts: 0,
		maxAttempts: 3,
		backoffType: "exponential",
		backoffDelayMs: 1000,
		leaseUntil: null,
		runnerId: null,
		claimToken: null,
		result: null,
		error: null,
		startedAt: null,
		runAt: new Date(),
		completedAt: null,
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	};
}

export function createMockWorkerRuntime(
	overrides: { registry?: Partial<WorkerRuntimeRegistry>; pool?: Partial<WorkerRuntimePool>; queue?: Partial<WorkerRuntimeQueue> } = {},
): WorkerRuntime {
	return {
		registry: {
			get: () => {
				// intentionally empty
			},
			has: () => false,
			getAll: () => [],
			...overrides.registry,
		},
		pool: {
			get totalRunningCount() {
				return overrides.pool?.totalRunningCount ?? 0;
			},
			runningCountFor: overrides.pool?.runningCountFor ?? (() => 0),
			getActiveJobIds: overrides.pool?.getActiveJobIds ?? (() => []),
			cancel:
				overrides.pool?.cancel ??
				(() => {
					// intentionally empty
				}),
			cancelAllForWorker: overrides.pool?.cancelAllForWorker ?? (() => 0),
			start:
				overrides.pool?.start ??
				(() => {
					// intentionally empty
				}),
		},
		queue: {
			enqueue: overrides.queue?.enqueue ?? (() => Promise.resolve(createMockWorkerItem())),
			enqueueMany: overrides.queue?.enqueueMany ?? (() => Promise.resolve([])),
			findActive: overrides.queue?.findActive ?? (() => Promise.resolve(MOCK_FIND_NOTHING)),
			cancelAllPending: overrides.queue?.cancelAllPending ?? (() => Promise.resolve(0)),
		},
	};
}
