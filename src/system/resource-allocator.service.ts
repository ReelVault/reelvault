import { serverConfig } from "@/config/server/server.config";
import { HOUR, MINUTE } from "@/config/server/server.constants";
import { serverRescueService } from "@/system/server-rescue.service";
import { createLogger } from "@/utils/logger.utils";
import { detach } from "@/utils/promise.utils";
import { RecurringTimer } from "@/utils/recurring-timer.utils";
import { readHostMetrics, readLoadAverage } from "./resource-allocator/host-metrics.reader";
import { resourceAllocatorStorage } from "./resource-allocator/resource-allocator.ports";
import type {
	AlertDraft,
	ResourceAlert,
	ResourceMetricsReader,
	ResourceSnapshot,
	WorkerAllocation,
} from "./resource-allocator/resource-allocator.types";
import { calculatePressure, thresholdAlerts } from "./resource-allocator/thresholds.utils";
import { computeWorkerAllocation, workerConcurrencyCeiling } from "./resource-allocator/worker.allocator";
import { systemAdminBroadcast } from "./system.ports";

const METRICS_FLUSH_INTERVAL_MS = 25_000;
const ALERT_COOLDOWN_MS = 5 * MINUTE;
const MAX_RECENT_ALERTS = 100;
const RECENT_ALERTS_KEPT = 50;

export class ResourceAllocator {
	readonly serviceName = "ResourceAllocator";
	readonly logger = createLogger("ResourceAllocator");

	private currentSnapshot?: ResourceSnapshot | undefined;
	private recentAlerts: ResourceAlert[] = [];
	private readonly alertCooldowns = new Map<string, number>();
	private readonly monitorTimer = new RecurringTimer(async () => {
		try {
			await this.collectSnapshot();
		} catch (error) {
			this.logger.error("Resource snapshot failed", error);
		}
	}, serverConfig.resources.monitoringIntervalMs);
	private lastFlushAt = 0;
	private collecting = false;
	private isShutdown = false;
	private activeWorkersProvider?: (() => Record<string, number>) | undefined;
	private activeStreamsProvider?: (() => number) | undefined;
	private readonly readMetrics: ResourceMetricsReader;

	/** `readMetrics` supplies the host readings; by default they come from the real CPU, memory and disk. */
	constructor(readMetrics: ResourceMetricsReader = readHostMetrics) {
		this.readMetrics = readMetrics;
	}

	registerActiveWorkersProvider(provider: () => Record<string, number>): void {
		this.activeWorkersProvider = provider;
	}

	registerActiveStreamsProvider(provider: () => number): void {
		this.activeStreamsProvider = provider;
	}

	async initialize(): Promise<void> {
		if (!serverConfig.resources.monitoringEnabled) {
			this.logger.info("Resource monitoring disabled");

			return;
		}

		await this.collectSnapshot();
		this.armMonitorInterval();
		this.logger.info("Resource allocator initialized", { intervalMs: serverConfig.resources.monitoringIntervalMs });
	}

	/** Re-arms sampling after the interval or the enabled flag changed, so the change applies without a restart. */
	rescheduleMonitoring(): void {
		if (this.isShutdown) return;

		this.disarmMonitorInterval();
		if (!serverConfig.resources.monitoringEnabled) {
			this.logger.info("Resource monitoring disabled");

			return;
		}

		this.armMonitorInterval();
		this.logger.info("Resource monitoring rescheduled", { intervalMs: serverConfig.resources.monitoringIntervalMs });
	}

	async shutdown(): Promise<void> {
		this.isShutdown = true;
		this.disarmMonitorInterval();

		await this.flushToDatabase(true);
		this.logger.info("Resource allocator shut down");
	}

	getCurrentSnapshot(): ResourceSnapshot | undefined {
		return this.currentSnapshot;
	}

	getRecentAlerts(): ResourceAlert[] {
		const cutoff = Date.now() - HOUR;

		return this.recentAlerts.filter((a) => a.timestamp > cutoff);
	}

	getWorkerAllocation(workerId: string): WorkerAllocation {
		// Server rescue outranks everything, including explicit admin concurrency:
		// when the server is drowning, background work stops. Playback workers are exempt.
		const rescueAllocation = serverRescueService.getRescueAllocation(workerId);
		if (rescueAllocation) return { workerId, requested: 0, ...rescueAllocation };

		return computeWorkerAllocation(workerId, this.currentSnapshot);
	}

	/** Absolute concurrency ceiling for a worker id (admin/plugin settings can never exceed it). */
	getWorkerConcurrencyCeiling(workerId: string): number {
		return workerConcurrencyCeiling(workerId);
	}

	private armMonitorInterval(): void {
		this.monitorTimer.start();
	}

	private disarmMonitorInterval(): void {
		this.monitorTimer.stop();
	}

	private async collectSnapshot(): Promise<void> {
		if (this.collecting || this.isShutdown) return;

		this.collecting = true;
		try {
			const { cpuUsedPercent, memory, disk } = await this.readMetrics();
			const activeStreams = this.getActiveStreams();
			const workers = this.activeWorkersProvider?.() ?? {};
			const pressure = calculatePressure(cpuUsedPercent, memory.percent, disk.percent);
			const now = Date.now();

			this.currentSnapshot = {
				timestamp: now,
				cpu: { usedPercent: cpuUsedPercent, loadAvg: readLoadAverage() },
				memory,
				disk,
				pressure,
				activeStreams,
				workers,
			};

			if (now - this.lastFlushAt > METRICS_FLUSH_INTERVAL_MS) {
				await this.flushToDatabase(false);
			}

			for (const alert of thresholdAlerts(this.currentSnapshot)) this.createAlert(alert);
		} catch (error) {
			this.logger.error("Failed to collect resource snapshot", error);
		} finally {
			this.collecting = false;
		}
	}

	private getActiveStreams(): number {
		if (this.activeStreamsProvider) {
			try {
				return this.activeStreamsProvider();
			} catch (error) {
				this.logger.warn("Active streams provider failed", { error });

				return 0;
			}
		}

		try {
			return resourceAllocatorStorage().activeStreamCount();
		} catch (error) {
			this.logger.warn("Failed to load streaming service for resource monitoring", { error });

			return 0;
		}
	}

	private async flushToDatabase(force: boolean): Promise<void> {
		if (!this.currentSnapshot) return;

		if (!force && Date.now() - this.lastFlushAt < METRICS_FLUSH_INTERVAL_MS) return;

		try {
			const s = this.currentSnapshot;
			await resourceAllocatorStorage().recordMetrics({
				cpuUsedPercent: s.cpu.usedPercent,
				cpuLoadAvg1: s.cpu.loadAvg[0],
				cpuLoadAvg5: s.cpu.loadAvg[1],
				cpuLoadAvg15: s.cpu.loadAvg[2],
				memoryUsedMb: s.memory.usedMb,
				memoryTotalMb: s.memory.totalMb,
				memoryPercent: s.memory.percent,
				diskUsedGb: s.disk.usedGb,
				diskTotalGb: s.disk.totalGb,
				diskPercent: s.disk.percent,
				pressure: s.pressure,
				activeStreams: s.activeStreams,
				activeWorkers: s.workers,
			});
			this.lastFlushAt = Date.now();
		} catch (error) {
			this.logger.error("Failed to flush resource metrics", error);
		}
	}

	private createAlert(draft: AlertDraft): void {
		const now = Date.now();
		const lastForType = this.alertCooldowns.get(draft.type);
		if (lastForType !== undefined && now - lastForType < ALERT_COOLDOWN_MS) return;

		const alert: ResourceAlert = { timestamp: now, ...draft };
		this.recentAlerts.push(alert);
		this.alertCooldowns.set(draft.type, now);

		if (this.recentAlerts.length > MAX_RECENT_ALERTS) {
			this.recentAlerts = this.recentAlerts.slice(-RECENT_ALERTS_KEPT);
		}

		// Resource alerts feed the admin dashboard — keep them off non-admin sockets.
		resourceAllocatorStorage().notifyAlert(draft.code, draft.params ?? {});
		detach(this.broadcastAlert(alert));

		this.logger.warn(`Resource alert [${draft.severity}]`, { type: draft.type, code: draft.code, params: draft.params });
	}

	private async broadcastAlert(alert: ResourceAlert): Promise<void> {
		try {
			await systemAdminBroadcast().publishResourceAlert(alert);
		} catch (error) {
			this.logger.error("Failed to broadcast resource alert", error);
		}
	}
}

export const resourceAllocator = new ResourceAllocator();
