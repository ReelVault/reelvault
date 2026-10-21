import { statfs } from "node:fs/promises";
import type { HealthStatus, SubsystemStatus } from "@reelvault/sdk/common";
import { env } from "@/config/env.config";
import { serverConfig } from "@/config/server/server.config";
import { ffMpegService } from "@/integrations/ffmpeg/ffmpeg.service";
import { mediaRepository } from "@/repositories/media-files.repository";
import { getMemoryInfo } from "@/system/resource-allocator/host-metrics.reader";
import { resourceAllocator } from "@/system/resource-allocator.service";
import { MIB } from "@/utils/bytes.utils";
import { errorMessage } from "@/utils/domain.errors";
import { createLogger } from "@/utils/logger.utils";
import { MemoryCache } from "@/utils/memory.cache";
import { runSafely } from "@/utils/safe-execute.utils";

const HEALTH_CACHE_TTL_MS = 10_000;

function resourceStatusFromUsage(name: string, usedPercent: number, freeLabel: string): SubsystemStatus {
	if (usedPercent >= 95) return { name, status: "unavailable", message: `Only ${freeLabel} (${usedPercent}% used)` };

	if (usedPercent >= 85) return { name, status: "degraded", message: `${freeLabel} (${usedPercent}% used)` };

	return { name, status: "healthy", message: freeLabel };
}

class HealthService {
	readonly serviceName = "HealthService";
	readonly logger = createLogger("HealthService");

	private readonly cache = new MemoryCache<HealthStatus>({ name: "health", ttlMs: HEALTH_CACHE_TTL_MS, maxSize: 1 });

	check(options?: { fresh?: boolean }): Promise<HealthStatus> {
		if (options?.fresh) {
			return runSafely(this, "check", async () => this.buildHealthStatus());
		}

		return this.cache.getOrSet("health", () => runSafely(this, "check", () => this.buildHealthStatus()));
	}

	/** Readiness: only what the API cannot work without (the database). Cheap enough for frequent orchestrator probes. */
	async checkReady(): Promise<HealthStatus> {
		return await runSafely(this, "checkReady", async () => {
			const database = await this.checkDatabase();

			return {
				status: database.status === "healthy" ? "ok" : "degraded",
				timestamp: new Date().toISOString(),
				uptime: process.uptime(),
				environment: env.NODE_ENV,
				subsystems: [database],
			};
		});
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
			environment: env.NODE_ENV,
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
			const totalGb = (stats.blocks * stats.bsize) / (1024 * MIB);
			const freeGb = (stats.bavail * stats.bsize) / (1024 * MIB);
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
