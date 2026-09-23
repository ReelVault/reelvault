import { statfs } from "node:fs/promises";
import type { HealthStatus, SubsystemStatus } from "@sdk/common";
import { mediaRepository } from "@/database/repositories/media-files.repository";
import { ffMpegService } from "@/integrations/ffmpeg/ffmpeg.service";
import { serverConfig } from "@/server.config";
import { getMemoryInfo, resourceAllocator } from "@/system/resource-allocator";
import { BaseService } from "@/utils/base-service";
import { errorMessage } from "@/utils/errors";
import { MemoryCache } from "@/utils/memory-cache";

const HEALTH_CACHE_TTL_MS = 10_000;

function resourceStatusFromUsage(name: string, usedPercent: number, freeLabel: string): SubsystemStatus {
	if (usedPercent >= 95) return { name, status: "unavailable", message: `Only ${freeLabel} (${usedPercent}% used)` };

	if (usedPercent >= 85) return { name, status: "degraded", message: `${freeLabel} (${usedPercent}% used)` };

	return { name, status: "healthy", message: freeLabel };
}

class HealthService extends BaseService {
	private readonly cache = new MemoryCache<HealthStatus>({ name: "health", ttlMs: HEALTH_CACHE_TTL_MS, maxSize: 1 });

	constructor() {
		super("HealthService");
	}

	check(options?: { fresh?: boolean }): Promise<HealthStatus> {
		if (options?.fresh) {
			return this.safeExecute("check", async () => this.buildHealthStatus());
		}

		return this.cache.getOrSet("health", () => this.safeExecute("check", () => this.buildHealthStatus()));
	}

	private async buildHealthStatus(): Promise<HealthStatus> {
		// Only checkDatabase/checkDisk can await (I/O); the rest are synchronous local reads.
		const [database, disk] = await Promise.all([this.checkDatabase(), this.checkDisk()]);
		const subsystems = [database, this.checkFFmpeg(), disk, this.checkMemory()];

		const hasUnhealthy = subsystems.some((s) => s.status === "unavailable");
		const hasDegraded = subsystems.some((s) => s.status === "degraded");

		return {
			status: hasUnhealthy || hasDegraded ? "degraded" : "ok",
			timestamp: new Date().toISOString(),
			uptime: process.uptime(),
			environment: process.env.NODE_ENV ?? "development",
			subsystems,
		};
	}

	private async checkDatabase(): Promise<SubsystemStatus> {
		try {
			await mediaRepository.ping();

			return { name: "database", status: "healthy" };
		} catch (error) {
			return { name: "database", status: "unavailable", message: errorMessage(error) };
		}
	}

	private checkFFmpeg(): SubsystemStatus {
		const available = ffMpegService.isAvailable();
		if (!available) {
			return { name: "ffmpeg", status: "unavailable", message: `Binary not found at: ${serverConfig.ffmpeg.path}` };
		}

		return { name: "ffmpeg", status: "healthy" };
	}

	private async checkDisk(): Promise<SubsystemStatus> {
		const snapshot = resourceAllocator.getCurrentSnapshot();
		if (snapshot) {
			const freeGb = Math.max(0, snapshot.disk.totalGb - snapshot.disk.usedGb);

			return resourceStatusFromUsage("disk", snapshot.disk.percent, `${freeGb.toFixed(1)} GB free`);
		}

		try {
			const stats = await statfs(serverConfig.paths.transcodes);
			const totalGb = (stats.blocks * stats.bsize) / (1024 * 1024 * 1024);
			const freeGb = (stats.bavail * stats.bsize) / (1024 * 1024 * 1024);
			const usedPercent = Math.round(((totalGb - freeGb) / totalGb) * 100);

			return resourceStatusFromUsage("disk", usedPercent, `${freeGb.toFixed(1)} GB free`);
		} catch (error) {
			return { name: "disk", status: "unavailable", message: errorMessage(error) };
		}
	}

	private checkMemory(): SubsystemStatus {
		const snapshot = resourceAllocator.getCurrentSnapshot();
		if (snapshot) {
			const freeMb = Math.max(0, snapshot.memory.totalMb - snapshot.memory.usedMb);

			return resourceStatusFromUsage("memory", snapshot.memory.percent, `${freeMb} MB free`);
		}

		try {
			const mem = getMemoryInfo();
			const freeMb = Math.max(0, mem.totalMb - mem.usedMb);

			return resourceStatusFromUsage("memory", mem.percent, `${freeMb} MB free`);
		} catch (error) {
			return { name: "memory", status: "unavailable", message: errorMessage(error) };
		}
	}
}

export const healthService = new HealthService();
