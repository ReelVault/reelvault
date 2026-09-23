import type { AdminResourcesResponse } from "@sdk/common";
import { resourceMetricsRepository } from "@/database/repositories/resource-metrics.repository";
import { serverConfig } from "@/server.config";
import { resourceAllocator } from "@/system/resource-allocator";
import { serverRescueService } from "@/system/server-rescue.service";
import { systemResourcesService } from "@/system/system-resources.service";
import { BaseService } from "@/utils/base-service";
import { serializeDate } from "@/utils/time.utils";

const ALLOCATION_WORKER_IDS = [
	"imageProcessing",
	"mediaFileAnalysis",
	"mediaFileTechnicalRefresh",
	"metadataRefresh",
	"scanning",
	"transcode",
];

class AdminResourcesService extends BaseService {
	constructor() {
		super("AdminResourcesService");
	}

	async getResourcesView(): Promise<AdminResourcesResponse> {
		return await this.safeExecute("getResourcesView", async () => {
			const [rawHistory, aggregates] = await Promise.all([
				resourceMetricsRepository.getHistory(24),
				resourceMetricsRepository.getAggregates(24),
			]);

			const current = resourceAllocator.getCurrentSnapshot();

			return {
				...(current ? { current } : {}),
				history: rawHistory.map((entry) => ({
					id: entry.id,
					timestamp: serializeDate(entry.createdAt),
					cpu: entry.cpuUsedPercent,
					memory: entry.memoryPercent,
					disk: entry.diskPercent,
					pressure: entry.pressure,
					workersJson: JSON.stringify(entry.activeWorkers),
				})),
				alerts: resourceAllocator.getRecentAlerts(),
				aggregates,
				config: {
					monitoringEnabled: serverConfig.resources.monitoringEnabled,
					memoryThresholdPercent: serverConfig.resources.memoryThresholdPercent,
					diskThresholdPercent: serverConfig.resources.diskThresholdPercent,
					enableDynamicThrottling: serverConfig.resources.enableDynamicThrottling,
				},
				systemCpu: systemResourcesService.getMetrics(),
				rescue: serverRescueService.getState(),
				workerAllocations: ALLOCATION_WORKER_IDS.map((id) => resourceAllocator.getWorkerAllocation(id)),
			};
		});
	}
}

export const adminResourcesService = new AdminResourcesService();
