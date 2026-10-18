import type { SystemPressure } from "@/system/server-rescue.service";

export interface ResourceSnapshot {
	timestamp: number;
	cpu: { usedPercent: number; loadAvg: [number, number, number] };
	memory: { usedMb: number; totalMb: number; percent: number };
	disk: { usedGb: number; totalGb: number; percent: number };
	pressure: SystemPressure;
	activeStreams: number;
	workers: Record<string, number>;
}

export interface WorkerAllocation {
	workerId: string;
	requested: number;
	allocated: number;
	throttled: boolean;
	reason?: string | undefined;
}

export interface ResourceAlert {
	timestamp: number;
	severity: "warning" | "critical";
	type: string;
	/** Stable machine code — the frontend translates it. */
	code: string;
	params?: Record<string, string | number | boolean | null> | undefined;
}

export type AlertDraft = Omit<ResourceAlert, "timestamp">;

/** Host readings one snapshot is built from. */
export interface ResourceMetrics {
	cpuUsedPercent: number;
	memory: ResourceSnapshot["memory"];
	disk: ResourceSnapshot["disk"];
}

export type ResourceMetricsReader = () => Promise<ResourceMetrics>;
