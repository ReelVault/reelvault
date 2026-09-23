import { statfs } from "node:fs/promises";
import { freemem, loadavg, totalmem } from "node:os";
import { file as bunFile } from "bun";
import { resourceMetricsRepository } from "@/database/repositories/resource-metrics.repository";
import { realtimeService } from "@/modules/realtime";
import { streamingService } from "@/modules/streaming/runtime/streaming.manager";
import { serverConfig } from "@/server.config";
import { HOUR, MINUTE } from "@/server.constants";
import { systemResourcesService } from "@/system/system-resources.service";
import { BaseService } from "@/utils/base-service";
import { clamp } from "@/utils/math.utils";
import { getAvailableMemoryKiB, getTotalMemoryKiB, readCgroupMemoryLimitKiB, readCgroupMemoryUsageKiB } from "@/utils/mem.utils";
import { detach } from "@/utils/promise.utils";
import { isFiniteNumber } from "@/utils/type.utils";
import { type CanonicalWorkerId, canonicalWorkerId } from "@/workers/worker-ids";
import { type SystemPressure, serverRescueService } from "./server-rescue.service";

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

const WORKER_WEIGHTS: Record<string, number> = {
	"image-processing": 80,
	"media-file-technical-refresh": 60,
	"metadata-refresh": 40,
	"media-file-analysis": 30,
	scanning: 5,
};

const METRICS_FLUSH_INTERVAL_MS = 25_000;

const ALERT_COOLDOWN_MS = 5 * MINUTE;

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

export function getMemoryInfo(): { usedMb: number; totalMb: number; percent: number } {
	const cgroupLimitKiB = readCgroupMemoryLimitKiB();
	const cgroupUsageKiB = readCgroupMemoryUsageKiB();

	if (cgroupLimitKiB !== undefined) {
		const totalMb = Math.round(cgroupLimitKiB / 1024);
		const usedMb = Math.round((cgroupUsageKiB ?? 0) / 1024);
		if (totalMb > 0) {
			return { usedMb, totalMb, percent: Math.round((usedMb / totalMb) * 100 * 10) / 10 };
		}
	}

	// Reuse the shared /proc/meminfo readers instead of re-parsing the file here.
	const totalKiB = getTotalMemoryKiB();
	const availableKiB = getAvailableMemoryKiB();
	if (totalKiB !== undefined && totalKiB > 0 && availableKiB !== undefined && availableKiB > 0) {
		const totalMb = Math.round(totalKiB / 1024);
		const usedMb = Math.round((totalKiB - availableKiB) / 1024);

		return { usedMb, totalMb, percent: Math.round((usedMb / totalMb) * 100 * 10) / 10 };
	}

	const totalMb = Math.round(totalmem() / 1024 / 1024);
	const freeMb = Math.round(freemem() / 1024 / 1024);
	const usedMb = totalMb - freeMb;

	return { usedMb, totalMb, percent: Math.round((usedMb / totalMb) * 100 * 10) / 10 };
}

async function getDiskInfo(path: string): Promise<{ usedGb: number; totalGb: number; percent: number }> {
	try {
		const stat = await statfs(path);
		const totalBytes = stat.blocks * stat.bsize;
		const freeBytes = stat.bavail * stat.bsize;
		const usedBytes = totalBytes - freeBytes;
		const totalGb = Math.round((totalBytes / 1024 / 1024 / 1024) * 10) / 10;
		const usedGb = Math.round((usedBytes / 1024 / 1024 / 1024) * 10) / 10;

		return { usedGb, totalGb, percent: Math.round((usedGb / totalGb) * 100 * 10) / 10 };
	} catch {
		return { usedGb: 0, totalGb: 0, percent: 0 };
	}
}

// CPU sampling state — we compare the current /proc/stat against the previous
// reading taken on the last monitoring interval. Two back-to-back reads in the
// same microsecond always produce delta≈0 (always 0% CPU), which is wrong.
let prevCpuTotal = 0;
let prevCpuIdle = 0;

// cgroup CPU accounting (v2 `cpu.stat` usage_usec / v1 cpuacct.usage). In a
// container /proc/stat reports the HOST, so a busy host makes the container look
// pegged; cgroup usage divided by the effective core quota is container-accurate.
const CGROUP_V2_CPU_STAT_PATH = "/sys/fs/cgroup/cpu.stat";
const CGROUP_V1_CPUACCT_PATH = "/sys/fs/cgroup/cpuacct/cpuacct.usage";
const CPU_USAGE_USEC_REGEX = /usage_usec\s+(\d+)/;
let prevCgroupUsageMicros = 0;
let prevCgroupSampleAt = 0;

// The cgroup hierarchy never changes at runtime — remember which source works
// instead of re-probing v2 and v1 (throwing) on every snapshot.
type CgroupCpuSource = "v2" | "v1" | "none";
let cgroupCpuSource: CgroupCpuSource | undefined;

async function readCgroupCpuUsageMicros(): Promise<number | undefined> {
	if (cgroupCpuSource === "none") return undefined;

	if (cgroupCpuSource === undefined || cgroupCpuSource === "v2") {
		try {
			const stat = await bunFile(CGROUP_V2_CPU_STAT_PATH).text();
			const match = CPU_USAGE_USEC_REGEX.exec(stat);
			if (match?.[1]) {
				cgroupCpuSource = "v2";

				return Number.parseInt(match[1], 10);
			}
		} catch {
			// Cgroup v2 cpu.stat unreadable — fall back to v1.
		}

		if (cgroupCpuSource === "v2") return undefined;
	}

	try {
		const nanos = Number.parseInt((await bunFile(CGROUP_V1_CPUACCT_PATH).text()).trim(), 10);
		if (isFiniteNumber(nanos)) {
			cgroupCpuSource = "v1";

			return nanos / 1000;
		}
	} catch {
		// Cgroup v1 cpuacct unreadable — report usage as unavailable.
	}

	cgroupCpuSource = "none";

	return undefined;
}

async function getCgroupCpuDelta(): Promise<number> {
	// Returns NaN when no cgroup usage is available yet (the caller then falls
	// back to /proc/stat for this round).
	const usageMicros = await readCgroupCpuUsageMicros();
	const now = Date.now();
	if (usageMicros !== undefined && prevCgroupSampleAt !== 0) {
		const usageDeltaMicros = usageMicros - prevCgroupUsageMicros;
		const timeDeltaMicros = (now - prevCgroupSampleAt) * 1000;
		prevCgroupUsageMicros = usageMicros;
		prevCgroupSampleAt = now;

		const effectiveCores = systemResourcesService.getMetrics().effectiveCores;
		if (timeDeltaMicros <= 0 || usageDeltaMicros < 0 || effectiveCores <= 0) return 0;

		const coresUsed = usageDeltaMicros / timeDeltaMicros;

		return Math.round(clamp((coresUsed / effectiveCores) * 100, 0, 100) * 10) / 10;
	}

	return Number.NaN;
}

async function getCgroupCpuUsage(): Promise<number | undefined> {
	const delta = await getCgroupCpuDelta();

	return Number.isNaN(delta) ? undefined : delta;
}

async function getProcStatCpuUsage(): Promise<number> {
	try {
		const text = await bunFile("/proc/stat").text();
		const lineEnd = text.indexOf("\n");
		const cpuLine = lineEnd === -1 ? text.slice(text.indexOf(" ") + 1) : text.slice(text.indexOf(" ") + 1, lineEnd);

		let total = 0;
		let idle = 0;
		let fieldIndex = 0;
		let start = 0;

		for (let i = 0; i <= cpuLine.length; i++) {
			if (i === cpuLine.length || cpuLine.charCodeAt(i) === 32) {
				if (i > start) {
					const value = Number(cpuLine.slice(start, i));
					total += value;
					if (fieldIndex === 3 || fieldIndex === 4) idle += value;

					fieldIndex++;
				}

				start = i + 1;
			}
		}

		const totalDelta = total - prevCpuTotal;
		const idleDelta = idle - prevCpuIdle;

		prevCpuTotal = total;
		prevCpuIdle = idle;

		if (totalDelta <= 0) return 0;

		return Math.round(((totalDelta - idleDelta) / totalDelta) * 100 * 10) / 10;
	} catch {
		return 0;
	}
}

async function getCpuUsage(): Promise<number> {
	// Prefer container-aware accounting; fall back to host /proc/stat when the
	// process is not under a readable cgroup hierarchy.
	return (await getCgroupCpuUsage()) ?? (await getProcStatCpuUsage());
}

export class ResourceAllocator extends BaseService {
	private currentSnapshot?: ResourceSnapshot | undefined;
	private recentAlerts: ResourceAlert[] = [];
	private readonly alertCooldowns = new Map<string, number>();
	private monitorInterval?: Timer | undefined;
	private lastFlushAt = 0;
	private collecting = false;
	private isShutdown = false;
	private activeWorkersProvider?: (() => Record<string, number>) | undefined;
	private activeStreamsProvider?: (() => number) | undefined;

	constructor() {
		super("ResourceAllocator");
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
		const intervalMs = serverConfig.resources.monitoringIntervalMs;
		const collectSnapshotSafely = async (): Promise<void> => {
			try {
				await this.collectSnapshot();
			} catch (error) {
				this.logger.error("Resource snapshot failed", error);
			}
		};
		this.monitorInterval = setInterval(() => {
			detach(collectSnapshotSafely());
		}, intervalMs);
		this.monitorInterval.unref();
		this.logger.info("Resource allocator initialized", { intervalMs });
	}

	async shutdown(): Promise<void> {
		this.isShutdown = true;
		if (this.monitorInterval) {
			clearInterval(this.monitorInterval);
			this.monitorInterval = undefined;
		}

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

		const canonicalId = canonicalWorkerId(workerId);
		const userSetting = this.getUserSettingForWorker(canonicalId);
		const pressure = this.currentSnapshot?.pressure ?? "low";

		if (userSetting > 0) {
			const maxAllowed = this.getMaxForWorker(canonicalId);
			const allocated = Math.min(userSetting, maxAllowed);

			return {
				workerId,
				requested: userSetting,
				allocated,
				throttled: allocated < userSetting,
				reason: allocated < userSetting ? "streaming_limit" : undefined,
			};
		}

		const autoConcurrency = systemResourcesService.getWorkerAutoConcurrency(workerId);

		if (!serverConfig.resources.enableDynamicThrottling) {
			return { workerId, requested: 0, allocated: autoConcurrency, throttled: false };
		}

		if (pressure === "critical") {
			if (canonicalId === "transcode") {
				return { workerId, requested: 0, allocated: Math.max(1, serverConfig.resources.streamingGuaranteedCores), throttled: false };
			}

			return { workerId, requested: 0, allocated: 0, throttled: true, reason: "critical_pressure" };
		}

		const weight = canonicalId ? (WORKER_WEIGHTS[canonicalId] ?? 50) : 50;

		if (pressure === "high" && weight < 30) {
			return { workerId, requested: 0, allocated: 0, throttled: true, reason: "high_pressure_low_priority" };
		}

		const throttleThreshold = serverConfig.resources.throttleLowPriorityAbovePercent;
		if (pressure === "medium" && this.currentSnapshot && this.currentSnapshot.memory.percent > throttleThreshold && weight < 50) {
			return { workerId, requested: 0, allocated: Math.max(1, Math.ceil(autoConcurrency / 2)), throttled: true, reason: "memory_pressure" };
		}

		return { workerId, requested: 0, allocated: autoConcurrency, throttled: false };
	}

	/** Absolute concurrency ceiling for a worker id (admin/plugin settings can never exceed it). */
	getWorkerConcurrencyCeiling(workerId: string): number {
		return this.getMaxForWorker(canonicalWorkerId(workerId));
	}

	// Callers pass the already-canonicalized id — `getWorkerAllocation` maps once.
	private getUserSettingForWorker(canonicalId: CanonicalWorkerId | undefined): number {
		return canonicalId ? (WORKER_USER_SETTINGS[canonicalId]?.() ?? 0) : 0;
	}

	private getMaxForWorker(canonicalId: CanonicalWorkerId | undefined): number {
		return canonicalId ? (WORKER_MAX_CONCURRENCY[canonicalId] ?? 4) : 4;
	}

	private async collectSnapshot(): Promise<void> {
		if (this.collecting || this.isShutdown) return;

		this.collecting = true;
		try {
			const [cpuUsed, disk] = await Promise.all([getCpuUsage(), getDiskInfo(serverConfig.paths.transcodes)]);
			const memory = getMemoryInfo();
			const [load1 = 0, load5 = 0, load15 = 0] = loadavg();
			const activeStreams = this.getActiveStreams();
			const workers = this.activeWorkersProvider?.() ?? {};
			const pressure = this.calculatePressure(cpuUsed, memory.percent, disk.percent);
			const now = Date.now();

			this.currentSnapshot = {
				timestamp: now,
				cpu: { usedPercent: cpuUsed, loadAvg: [load1, load5, load15] },
				memory,
				disk,
				pressure,
				activeStreams,
				workers,
			};

			if (now - this.lastFlushAt > METRICS_FLUSH_INTERVAL_MS) {
				await this.flushToDatabase(false);
			}

			this.checkThresholds(this.currentSnapshot);
		} catch (error) {
			this.logger.error("Failed to collect resource snapshot", error);
		} finally {
			this.collecting = false;
		}
	}

	private calculatePressure(cpu: number, mem: number, disk: number): SystemPressure {
		// Memory/disk exhaustion is critical on its own. Sustained high CPU is
		// NOT: a software transcode on a slow CPU legitimately pins the box at
		// 95-100% — treating that as critical made rescue kill background work
		// in engage→release loops. CPU alone tops out at "high" (throttles
		// background workers); rescue still escalates on event-loop lag.
		const memoryOrDisk = Math.max(mem, disk);
		if (memoryOrDisk >= 95) return "critical";

		const max = Math.max(cpu, memoryOrDisk);
		if (max >= 85) return "high";

		if (max >= 70) return "medium";

		return "low";
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
			return streamingService.getActiveSessions();
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
			await resourceMetricsRepository.create({
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

	private checkThresholds(snapshot: ResourceSnapshot): void {
		const memThreshold = serverConfig.resources.memoryThresholdPercent;
		const memCritical = serverConfig.resources.memoryCriticalPercent;
		const diskThreshold = serverConfig.resources.diskThresholdPercent;

		if (snapshot.memory.percent >= memCritical) {
			this.createAlert("critical", "memory", "system.memory_critical", { percent: snapshot.memory.percent });
		} else if (snapshot.memory.percent >= memThreshold) {
			this.createAlert("warning", "memory", "system.memory_high", { percent: snapshot.memory.percent });
		}

		if (snapshot.disk.percent >= diskThreshold) {
			this.createAlert("warning", "disk", "system.disk_low", { percent: snapshot.disk.percent });
		}
	}

	private createAlert(
		severity: "warning" | "critical",
		type: string,
		code: string,
		params?: Record<string, string | number | boolean | null>,
	): void {
		const now = Date.now();
		const lastForType = this.alertCooldowns.get(type);
		if (lastForType !== undefined && now - lastForType < ALERT_COOLDOWN_MS) return;

		const alert: ResourceAlert = { timestamp: now, severity, type, code, params };
		this.recentAlerts.push(alert);
		this.alertCooldowns.set(type, now);

		if (this.recentAlerts.length > 100) {
			this.recentAlerts = this.recentAlerts.slice(-50);
		}

		// Resource alerts feed the admin dashboard — keep them off non-admin sockets.
		detach(
			(async () => {
				try {
					await realtimeService.sendToAdmins("system.resource_alert", alert);
				} catch (error) {
					this.logger.error("Failed to broadcast resource alert", error);
				}
			})(),
		);

		this.logger.warn(`Resource alert [${severity}]`, { type, code, params });
	}
}

export const resourceAllocator = new ResourceAllocator();
