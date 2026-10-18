import { serverConfig } from "@/config/server/server.config";
import { systemResourcesService } from "@/config/system-resources.service";
import { type CanonicalWorkerId, canonicalWorkerId } from "@/config/worker-ids.utils";
import type { ResourceSnapshot, WorkerAllocation } from "./resource-allocator.types";

const WORKER_WEIGHTS: Record<string, number> = {
	"image-processing": 80,
	"media-file-technical-refresh": 60,
	"metadata-refresh": 40,
	"media-file-analysis": 30,
	scanning: 5,
};

const DEFAULT_WORKER_WEIGHT = 50;
const DEFAULT_MAX_CONCURRENCY = 4;

// User-defined per-worker concurrency getters — hoisted to module scope to
// avoid rebuilding the map (and its closures) on every allocation check.
const WORKER_USER_SETTINGS: Record<string, () => number> = {
	"image-processing": () => serverConfig.workers.definitions.imageProcessing.concurrency,
	"media-file-analysis": () => serverConfig.workers.definitions.mediaFileAnalysis.concurrency,
	"media-file-technical-refresh": () => serverConfig.workers.definitions.mediaFileTechnicalRefresh.concurrency,
	"metadata-refresh": () => serverConfig.workers.definitions.metadataRefresh.concurrency,
	scanning: () => serverConfig.scanning.concurrency,
};

// These are ABSOLUTE MAXIMUMS — the admin cannot exceed these regardless of settings.
// Set conservatively for older/slower CPUs (e.g. Xeon E5 in Proxmox containers).
// Modern high-core-count machines can raise these via custom resource profiles.
const WORKER_MAX_CONCURRENCY: Record<string, number> = {
	"image-processing": 8,
	"media-file-analysis": 6,
	"media-file-technical-refresh": 6,
	"metadata-refresh": 8,
	scanning: 16,
	transcode: 8,
};

/** Absolute concurrency ceiling for a worker id (admin/plugin settings can never exceed it). */
export function workerConcurrencyCeiling(workerId: string): number {
	return maxConcurrencyOf(canonicalWorkerId(workerId));
}

function maxConcurrencyOf(canonicalId: CanonicalWorkerId | undefined): number {
	return canonicalId ? (WORKER_MAX_CONCURRENCY[canonicalId] ?? DEFAULT_MAX_CONCURRENCY) : DEFAULT_MAX_CONCURRENCY;
}

/** Concurrency a worker may run at now: the admin's setting capped by the ceiling, else the automatic value under the current pressure. */
export function computeWorkerAllocation(workerId: string, snapshot: ResourceSnapshot | undefined): WorkerAllocation {
	const canonicalId = canonicalWorkerId(workerId);
	const userSetting = canonicalId ? (WORKER_USER_SETTINGS[canonicalId]?.() ?? 0) : 0;

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
	const weight = canonicalId ? (WORKER_WEIGHTS[canonicalId] ?? DEFAULT_WORKER_WEIGHT) : DEFAULT_WORKER_WEIGHT;

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
