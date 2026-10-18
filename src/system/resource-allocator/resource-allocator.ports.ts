import { DomainError } from "@/utils/domain.errors";
import type { ResourceSnapshot } from "./resource-allocator.types";

/** One resource snapshot as it is stored for the admin metrics history. */
export interface ResourceMetricsSample {
	cpuUsedPercent: number;
	cpuLoadAvg1: number;
	cpuLoadAvg5: number;
	cpuLoadAvg15: number;
	memoryUsedMb: number;
	memoryTotalMb: number;
	memoryPercent: number;
	diskUsedGb: number;
	diskTotalGb: number;
	diskPercent: number;
	pressure: ResourceSnapshot["pressure"];
	activeStreams: number;
	activeWorkers: Record<string, number>;
}

/**
 * Outbound effects of the resource allocator. The application layer registers an
 * implementation at startup, so the allocator never imports the database or the admin services.
 */
export interface ResourceAllocatorStoragePort {
	recordMetrics(sample: ResourceMetricsSample): Promise<void>;
	notifyAlert(code: string, params: Record<string, unknown>): void;
	activeStreamCount(): number;
}

let storagePort: ResourceAllocatorStoragePort | undefined;

export function wireResourceAllocatorStorage(port: ResourceAllocatorStoragePort): void {
	storagePort = port;
}

export function resourceAllocatorStorage(): ResourceAllocatorStoragePort {
	if (!storagePort) {
		throw new DomainError("internal", "Resource allocator storage port is not wired", { code: "resource_allocator.port_not_wired" });
	}

	return storagePort;
}
