import type { AdminResourcesResponse } from "@reelvault/sdk/common";
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

/** The history window of the resources page; the monitor keeps about a week of samples. */
export const RESOURCE_HISTORY_MAX_HOURS = 168;
const DEFAULT_RESOURCE_HOURS = 24;

const CSV_HEADER = "timestamp,cpuPercent,memoryPercent,diskPercent,pressure,activeWorkers";

/** Quotes a CSV cell when it holds a separator, a quote or a line break. */
const CSV_SPECIAL_CHARACTERS = /[",\n\r]/;

function csvCell(value: string | number | boolean | null | undefined): string {
	const text = String(value ?? "");

	return CSV_SPECIAL_CHARACTERS.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

class AdminResourcesService extends BaseService {
	constructor() {
		super("AdminResourcesService");
	}

	async getResourcesView(hours = DEFAULT_RESOURCE_HOURS): Promise<AdminResourcesResponse> {
		return await this.safeExecute("getResourcesView", async () => {
			const [rawHistory, aggregates] = await Promise.all([
				resourceMetricsRepository.getHistory(hours),
				resourceMetricsRepository.getAggregates(hours),
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

	/** Every sample of the window, unthinned, as CSV or JSON for offline analysis. */
	exportHistory(hours = DEFAULT_RESOURCE_HOURS, format: "csv" | "json" = "csv") {
		return this.safeExecute("exportHistory", async () => {
			// An infinite point budget disables the chart thinning, so the export keeps every sample.
			const samples = await resourceMetricsRepository.getHistory(hours, Number.POSITIVE_INFINITY);
			const rows = samples.map((sample) => ({
				timestamp: serializeDate(sample.createdAt),
				cpuPercent: sample.cpuUsedPercent,
				memoryPercent: sample.memoryPercent,
				diskPercent: sample.diskPercent,
				pressure: sample.pressure,
				activeWorkers: JSON.stringify(sample.activeWorkers),
			}));
			const filename = `resources-${hours}h.${format}`;

			if (format === "json") {
				return { body: JSON.stringify(rows, null, 2), contentType: "application/json", filename };
			}

			const lines = rows.map((row) =>
				Object.values(row)
					.map((cell) => csvCell(cell))
					.join(","),
			);

			return { body: `${[CSV_HEADER, ...lines].join("\n")}\n`, contentType: "text/csv; charset=utf-8", filename };
		});
	}
}

export const adminResourcesService = new AdminResourcesService();
