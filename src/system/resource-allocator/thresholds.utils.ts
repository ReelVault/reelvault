import { serverConfig } from "@/config/server/server.config";
import type { SystemPressure } from "@/system/server-rescue.service";
import type { AlertDraft, ResourceSnapshot } from "./resource-allocator.types";

/**
 * Memory/disk exhaustion is critical on its own. Sustained high CPU is NOT: a
 * software transcode on a slow CPU legitimately pins the box at 95-100% —
 * treating that as critical made rescue kill background work in engage→release
 * loops. CPU alone tops out at "high" (throttles background workers); rescue
 * still escalates on event-loop lag.
 */
export function calculatePressure(cpu: number, mem: number, disk: number): SystemPressure {
	const memoryOrDisk = Math.max(mem, disk);
	if (memoryOrDisk >= 95) return "critical";

	const max = Math.max(cpu, memoryOrDisk);
	if (max >= 85) return "high";

	if (max >= 70) return "medium";

	return "low";
}

/** Memory and disk readings at or above their configured thresholds. */
export function thresholdAlerts(snapshot: ResourceSnapshot): AlertDraft[] {
	const { memoryThresholdPercent, memoryCriticalPercent, diskThresholdPercent } = serverConfig.resources;
	const alerts: AlertDraft[] = [];

	if (snapshot.memory.percent >= memoryCriticalPercent) {
		alerts.push({ severity: "critical", type: "memory", code: "system.memory_critical", params: { percent: snapshot.memory.percent } });
	} else if (snapshot.memory.percent >= memoryThresholdPercent) {
		alerts.push({ severity: "warning", type: "memory", code: "system.memory_high", params: { percent: snapshot.memory.percent } });
	}

	if (snapshot.disk.percent >= diskThresholdPercent) {
		alerts.push({ severity: "warning", type: "disk", code: "system.disk_low", params: { percent: snapshot.disk.percent } });
	}

	return alerts;
}
