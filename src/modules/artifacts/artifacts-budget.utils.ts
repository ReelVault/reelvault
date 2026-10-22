import { statfs } from "node:fs/promises";
import { serverConfig } from "@/config/server/server.config";
import { MIB } from "@/utils/bytes.utils";
import { DomainError } from "@/utils/domain.errors";
import { clamp } from "@/utils/math.utils";
import { MemoryCache } from "@/utils/memory.cache";

const GIBIBYTE = 1024 * MIB;
/** Auto budget (`coreMaxStorageGb = 0`): share of the artifacts volume capacity. */
const AUTO_BUDGET_CAPACITY_RATIO = 0.05;
const AUTO_BUDGET_MIN_BYTES = 5 * GIBIBYTE;
const AUTO_BUDGET_MAX_BYTES = 100 * GIBIBYTE;
/** Hard floor: writes stop before artifacts can take the last gigabyte of the volume. */
const MIN_FREE_BYTES = GIBIBYTE;
const VOLUME_CACHE_TTL_MS = 30_000;

interface ArtifactsVolume {
	totalBytes: number;
	freeBytes: number;
}

const volumeCache = new MemoryCache<ArtifactsVolume>({ ttlMs: VOLUME_CACHE_TTL_MS, maxSize: 1, name: "artifacts-volume" });

function budgetError(message: string, details: Record<string, number>): DomainError {
	return new DomainError("validation", message, { code: "artifact.storage_budget_exceeded", details });
}

/** True for the core-budget gate error — core writers use it to skip instead of failing. */
export function isStorageBudgetError(error: unknown): boolean {
	return error instanceof DomainError && error.category === "validation" && error.code === "artifact.storage_budget_exceeded";
}

/** Auto budget formula: 5% of the volume capacity clamped to 5–100 GB. */
export function computeAutoBudgetBytes(volumeTotalBytes: number): number {
	return clamp(Math.round(volumeTotalBytes * AUTO_BUDGET_CAPACITY_RATIO), AUTO_BUDGET_MIN_BYTES, AUTO_BUDGET_MAX_BYTES);
}

async function readArtifactsVolume(): Promise<ArtifactsVolume> {
	return await volumeCache.getOrSet("volume", async () => {
		const stats = await statfs(serverConfig.paths.artifacts);

		return { totalBytes: stats.blocks * stats.bsize, freeBytes: stats.bavail * stats.bsize };
	});
}

/** Configured `system.artifacts.coreMaxStorageGb` in bytes, or the volume-derived auto budget when 0. */
export async function resolveCoreArtifactsBudgetBytes(): Promise<number> {
	const configuredGb = serverConfig.artifacts.coreMaxStorageGb;
	if (configuredGb > 0) return configuredGb * GIBIBYTE;

	try {
		return computeAutoBudgetBytes((await readArtifactsVolume()).totalBytes);
	} catch {
		// Volume unreadable — fall back to the auto ceiling instead of blocking generation.
		return AUTO_BUDGET_MAX_BYTES;
	}
}

/**
 * Core generators' write gate: rejects the write when it would exceed the core
 * artifacts budget or leave the artifacts volume below the free-space floor.
 */
export async function assertCoreArtifactsBudget(
	bytesAfterWrite: number,
	incomingBytes: number,
	readVolume: () => Promise<ArtifactsVolume> = readArtifactsVolume,
): Promise<void> {
	const budgetBytes = await resolveCoreArtifactsBudgetBytes();
	if (bytesAfterWrite > budgetBytes) {
		throw budgetError(`Core artifact storage budget exceeded (${bytesAfterWrite}/${budgetBytes} bytes)`, {
			bytesAfterWrite,
			budgetBytes,
		});
	}

	const volume = await readVolume().catch(() => null);
	if (volume && volume.freeBytes - incomingBytes < MIN_FREE_BYTES) {
		throw budgetError("Core artifact write rejected: artifacts volume is low on free space", {
			freeBytes: volume.freeBytes,
			minimumFreeBytes: MIN_FREE_BYTES,
		});
	}
}
