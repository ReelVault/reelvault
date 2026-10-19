import { serverConfig } from "@/config/server/server.config";
import { systemResourcesService } from "@/config/system-resources.service";
import { type CanonicalWorkerId, canonicalWorkerId } from "@/config/worker-ids.utils";
import type { ResourceSnapshot, WorkerAllocation } from "./resource-allocator.types";

interface WorkerResourceProfile {
	/** Prioritisation weight under memory/CPU pressure (higher = kept longer). */
	weight: number;
	/** Absolute ceiling the admin or plugin setting can never exceed. */
	maxConcurrency: number;
	/** Admin-configured concurrency for this category (0 = derive automatically). */
	userConcurrency: () => number;
}

const DEFAULT_WORKER_WEIGHT = 50;
const DEFAULT_MAX_CONCURRENCY = 4;

// One entry per resource category: weight, absolute concurrency ceiling and the
// admin setting all live together, so adding a category touches this table only.
// Ceilings are set conservatively for older/slower CPUs (e.g. Xeon E5 in
// Proxmox containers); modern high-core machines raise them via profiles.
const WORKER_RESOURCE_PROFILES: Partial<Record<CanonicalWorkerId, WorkerResourceProfile>> = {
	"image-processing": {
		weight: 80,
		maxConcurrency: 8,
		userConcurrency: () => serverConfig.workers.definitions.imageProcessing.concurrency,
	},
	"media-file-technical-refresh": {
		weight: 60,
		maxConcurrency: 6,
		userConcurrency: () => serverConfig.workers.definitions.mediaFileTechnicalRefresh.concurrency,
	},
	"metadata-refresh": {
		weight: 40,
		maxConcurrency: 8,
		userConcurrency: () => serverConfig.workers.definitions.metadataRefresh.concurrency,
	},
	"media-file-analysis": {
		weight: 30,
		maxConcurrency: 6,
		userConcurrency: () => serverConfig.workers.definitions.mediaFileAnalysis.concurrency,
	},
	scanning: {
		weight: 5,
		maxConcurrency: 16,
		userConcurrency: () => serverConfig.scanning.concurrency,
	},
	transcode: {
		weight: DEFAULT_WORKER_WEIGHT,
		maxConcurrency: 8,
		userConcurrency: () => 0,
	},
};

/** Absolute concurrency ceiling for a worker id (admin/plugin settings can never exceed it). */
export function workerConcurrencyCeiling(workerId: string): number {
	return maxConcurrencyOf(canonicalWorkerId(workerId));
}

function maxConcurrencyOf(canonicalId: CanonicalWorkerId | undefined): number {
	return (canonicalId && WORKER_RESOURCE_PROFILES[canonicalId]?.maxConcurrency) ?? DEFAULT_MAX_CONCURRENCY;
}

/** Concurrency a worker may run at now: the admin's setting capped by the ceiling, else the automatic value under the current pressure. */
export function computeWorkerAllocation(workerId: string, snapshot: ResourceSnapshot | undefined): WorkerAllocation {
	const canonicalId = canonicalWorkerId(workerId);
	const userSetting = canonicalId ? (WORKER_RESOURCE_PROFILES[canonicalId]?.userConcurrency() ?? 0) : 0;

	if (userSetting > 0) {
		const allocated = Math.min(userSetting, maxConcurrencyOf(canonicalId));

		return {
			workerId,
			requested: userSetting,
			allocated,
			throttled: allocated < userSetting,
			reason: allocated < userSetting ? "streaming_limit" : undefined,
		};
	}

	const autoConcurrency = systemResourcesService.getWorkerAutoConcurrency(workerId);
	const unthrottled: WorkerAllocation = { workerId, requested: 0, allocated: autoConcurrency, throttled: false };

	if (!serverConfig.resources.enableDynamicThrottling) return unthrottled;

	return allocationUnderPressure(workerId, canonicalId, autoConcurrency, snapshot) ?? unthrottled;
}

/** The throttled allocation for the current pressure, or undefined when the worker runs unthrottled. */
function allocationUnderPressure(
	workerId: string,
	canonicalId: CanonicalWorkerId | undefined,
	autoConcurrency: number,
	snapshot: ResourceSnapshot | undefined,
): WorkerAllocation | undefined {
	const pressure = snapshot?.pressure ?? "low";
	const weight = (canonicalId && WORKER_RESOURCE_PROFILES[canonicalId]?.weight) ?? DEFAULT_WORKER_WEIGHT;

	if (pressure === "critical") {
		if (canonicalId === "transcode") {
			return { workerId, requested: 0, allocated: Math.max(1, serverConfig.resources.streamingGuaranteedCores), throttled: false };
		}

		return { workerId, requested: 0, allocated: 0, throttled: true, reason: "critical_pressure" };
	}

	if (pressure === "high" && weight < 30) {
		return { workerId, requested: 0, allocated: 0, throttled: true, reason: "high_pressure_low_priority" };
	}

	const throttleThreshold = serverConfig.resources.throttleLowPriorityAbovePercent;
	if (pressure === "medium" && snapshot && snapshot.memory.percent > throttleThreshold && weight < 50) {
		return { workerId, requested: 0, allocated: Math.max(1, Math.ceil(autoConcurrency / 2)), throttled: true, reason: "memory_pressure" };
	}

	return undefined;
}
