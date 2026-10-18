import type { CpuProfile } from "@/config/system-settings.types";
import { type CanonicalWorkerId, canonicalWorkerId } from "@/config/worker-ids.utils";
import { clamp } from "@/utils/math.utils";
import { type CpuSettings, isReservedProfile } from "./settings.reader";

type WorkerId = "image-processing" | "metadata-refresh" | "media-file-technical-refresh" | "media-file-analysis";

export interface CpuResourceMetrics {
	readonly detectedCores: number;
	readonly configuredMaxCores: number;
	readonly effectiveCores: number;
	/** Single-core speed vs a modern desktop core, measured once at boot. */
	readonly speedFactor: number;
	/** effectiveCores × speedFactor — "modern-core equivalents" driving subprocess budgets. */
	readonly capacity: number;
	readonly reservedWebCores: number;
	readonly backgroundBudgetCores: number;
	readonly cpuProfile: CpuProfile;
	readonly ffmpegThreads: number;
	readonly sharpConcurrency: number;
	readonly workerPoolMaxConcurrent: number;
	readonly scannerConcurrency: number;
	readonly ffprobeConcurrency: number;
	/** Fraction of the last snapshot window the loop was blocked (0-1); undefined on the first snapshot. */
	readonly eventLoopUtilization?: number | undefined;
}

// Fraction of effective cores reserved for the web/HTTP layer.
// These are minimums — workers get what's left over.
// balanced is the default profile; slow cores auto-downgrade to conservative
// (see resolveReservedWebCores).
const PROFILE_RESERVE_RATIO: Readonly<Record<Exclude<CpuProfile, "custom">, number>> = {
	// 50% for web: safe on slow CPUs (Xeon E5, ARM SBCs, weak VMs).
	// On 12 cores → 6 for HTTP, 6 for workers. Workers capped per WORKER_BUDGET_RATIO.
	conservative: 0.5,
	// 33% for web: good balance on mid-range servers (12-24 cores at 2-3 GHz).
	// On 12 cores → 4 for HTTP, 8 for workers.
	balanced: 0.33,
	// 15% for web: for powerful dedicated media servers (16+ modern cores, NVMe).
	performance: 0.15,
};

// Upper clamps for the derived budgets — the values themselves come from
// formulas over effectiveCores (how many threads) and capacity (how much
// parallel subprocess work makes sense). Admin settings always win.
const CAPS = {
	ffmpegThreads: 8,
	sharpConcurrency: 4,
	poolMax: 12,
	ioConcurrency: 16,
	scannerConcurrency: 6,
	ffprobeConcurrency: 3,
	heavySubprocess: 2,
} as const;

// A single ffprobe/ffmpeg/sharp subprocess burns a whole core; budget how many
// run concurrently from capacity, never from raw thread count.
export const SLOW_CORE_FACTOR = 0.7;

// Per-worker auto-concurrency budgets.
// These are MAXIMUMS used when the admin leaves concurrency at "auto" (0).
// Input is capacity (modern-core equivalents), not raw thread count: twelve
// slow threads must not fund twelve simultaneous ffprobe/ffmpeg subprocesses.
const WORKER_BUDGET_RATIO: Readonly<Record<WorkerId, (capacity: number) => number>> = {
	// Image processing: CPU-intensive (Sharp/libvips). Cap at 4 to leave cores for HTTP.
	"image-processing": (c) => clamp(Math.ceil(c / 3), 1, 4),
	// Metadata refresh: mostly network I/O + DB. Can be a bit higher.
	"metadata-refresh": (c) => clamp(Math.ceil(c / 3), 1, 3),
	// Technical refresh: ffprobe subprocess per file — CPU-bound. Keep low.
	"media-file-technical-refresh": (c) => clamp(Math.ceil(c / 4), 1, 3),
	// Media file analysis: also ffprobe + DB writes. Same reasoning.
	"media-file-analysis": (c) => clamp(Math.ceil(c / 4), 1, 2),
};

/** Narrowing guard: only the budgeted workers have a ratio entry. */
function isBudgetedWorker(id: CanonicalWorkerId): id is WorkerId {
	return id in WORKER_BUDGET_RATIO;
}

/** Derives the CPU metrics snapshot from detected cores, admin settings and the measured speed factor. */
export function deriveCpuMetrics(
	detectedCores: number,
	settings: CpuSettings,
	speedFactor: number,
): Omit<CpuResourceMetrics, "eventLoopUtilization"> {
	const configuredMaxCores = settings.maxCores ?? detectedCores;
	const effectiveCores = clamp(Math.min(detectedCores, configuredMaxCores), 1, detectedCores);
	const capacity = Math.max(1, Math.round(effectiveCores * speedFactor));
	const reservedWebCores = resolveReservedWebCores(settings.cpuProfile, effectiveCores, speedFactor, settings.reservedWebCores);
	const halfCapacity = Math.floor(capacity / 2);

	return {
		detectedCores,
		configuredMaxCores,
		effectiveCores,
		speedFactor,
		capacity,
		reservedWebCores,
		backgroundBudgetCores: Math.max(1, effectiveCores - reservedWebCores),
		cpuProfile: settings.cpuProfile,
		// One transcode must not eat the whole machine: ~⅓ of the threads per
		// FFmpeg process leaves the rest for HTTP and other sessions.
		ffmpegThreads: settings.ffmpegThreads ?? clamp(Math.floor(effectiveCores / 3), 1, CAPS.ffmpegThreads),
		sharpConcurrency: clamp(halfCapacity, 1, CAPS.sharpConcurrency),
		workerPoolMaxConcurrent: settings.poolMaxConcurrent ?? clamp(Math.floor(capacity * 1.25), 3, CAPS.poolMax),
		scannerConcurrency: clamp(halfCapacity, 1, CAPS.scannerConcurrency),
		ffprobeConcurrency: clamp(halfCapacity, 1, CAPS.ffprobeConcurrency),
	};
}

function resolveReservedWebCores(profile: CpuProfile, effectiveCores: number, speedFactor: number, customSetting?: number): number {
	if (profile === "custom" && customSetting !== undefined) {
		return clamp(customSetting, 1, Math.max(1, effectiveCores - 1));
	}

	if (profile === "performance") {
		return effectiveCores > 2 ? clamp(Math.floor(effectiveCores * PROFILE_RESERVE_RATIO.performance), 1, effectiveCores) : 1;
	}

	let ratio = (isReservedProfile(profile) ? PROFILE_RESERVE_RATIO[profile] : undefined) ?? PROFILE_RESERVE_RATIO.balanced;
	// Slow cores hurt HTTP latency more than parallelism helps background
	// work — downgrade the default profile on E5-class CPUs. Explicitly
	// chosen conservative/performance profiles are respected as-is.
	if (profile === "balanced" && speedFactor < SLOW_CORE_FACTOR) ratio = PROFILE_RESERVE_RATIO.conservative;

	return Math.max(1, Math.ceil(effectiveCores * ratio));
}

/** How many CPU-heavy subprocesses (parallel ffmpeg decodes, test encodes)
 * may run at once, derived from capacity instead of raw thread count. */
export function heavySubprocessConcurrency(capacity: number): number {
	return clamp(Math.floor(capacity / 3), 1, CAPS.heavySubprocess);
}

/** Parallel file-system fan-outs (stat/unlink/read sweeps). Slow storage
 * (NAS, SD card) suffers as much from deep queues as a slow CPU does from
 * extra ffmpeg processes, so this scales with capacity too. */
export function ioConcurrency(capacity: number): number {
	return clamp(Math.floor(capacity * 2), 4, CAPS.ioConcurrency);
}

/** media-file-ingest tasks each run an ffprobe plus catalog writes. */
export function ingestConcurrency(capacity: number): number {
	return clamp(Math.floor(capacity / 2), 1, 3);
}

/** Heavy chunked relation queries fan out per metadata id — catalog reads,
 * same budget class as ingest, derived from measured capacity. */
export function relationQueryConcurrency(capacity: number): number {
	return clamp(Math.ceil(capacity / 2), 1, 8);
}

/** Auto concurrency for a worker by its canonical id; unbudgeted workers get 1. */
export function workerAutoConcurrency(workerId: string, capacity: number): number {
	const mappedId = canonicalWorkerId(workerId);
	if (!(mappedId && isBudgetedWorker(mappedId))) return 1;

	return WORKER_BUDGET_RATIO[mappedId](capacity);
}

/**
 * A value that scales with installed memory: `perGb` for each GiB of RAM,
 * clamped to [min, max]. Unknown RAM → `min`, so a cache we cannot size is
 * never over-allocated.
 */
export function ramScaled(totalKiB: number | undefined, perGb: number, min: number, max: number): number {
	if (totalKiB === undefined) return min;

	const memGb = totalKiB / 1024 / 1024;

	return clamp(Math.floor(memGb * perGb), min, max);
}
