import type { CpuProfile } from "@/config/system-settings.types";
import { type CanonicalWorkerId, canonicalWorkerId } from "@/config/worker-ids.utils";
import { MIB } from "@/utils/bytes.utils";
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
	trickplay: 4,
	softwareTranscode: 4,
} as const;

// A single ffprobe/ffmpeg/sharp subprocess burns a whole core; budget how many
// run concurrently from capacity, never from raw thread count.
export const SLOW_CORE_FACTOR = 0.7;

// Per-worker auto-concurrency budgets.
// These are MAXIMUMS used when the admin leaves concurrency at "auto" (0).
// Input is capacity (modern-core equivalents), not raw thread count: twelve
// slow threads must not fund twelve simultaneous ffprobe/ffmpeg subprocesses.
const WORKER_BUDGET_RATIO: Readonly<Record<WorkerId, CapacityBudget>> = {
	// Image processing: CPU-intensive (Sharp/libvips). Cap at 4 to leave cores for HTTP.
	"image-processing": { divisor: 3, min: 1, max: 4, rounding: "ceil" },
	// Metadata refresh: mostly network I/O + DB. Can be a bit higher.
	"metadata-refresh": { divisor: 3, min: 1, max: 3, rounding: "ceil" },
	// Technical refresh: ffprobe subprocess per file — CPU-bound. Keep low.
	"media-file-technical-refresh": { divisor: 4, min: 1, max: 3, rounding: "ceil" },
	// Media file analysis: also ffprobe + DB writes. Same reasoning.
	"media-file-analysis": { divisor: 4, min: 1, max: 2, rounding: "ceil" },
};

/**
 * A budget derived from the measured capacity. Every budget in this file is
 * "how much of the capacity may one thing use, clamped" — the shape is the
 * same, so it is written down once.
 */
export interface CapacityBudget {
	/** The divisor applied to the capacity before the clamp. */
	divisor: number;
	/** The lower bound. */
	min: number;
	/** The upper bound. */
	max: number;
	/** Rounding of the quotient: "floor" (default) or "ceil". */
	rounding?: "floor" | "ceil" | undefined;
	/** A multiplier applied to the capacity before the division. */
	multiplier?: number | undefined;
	/** A constant added after the rounding. */
	offset?: number | undefined;
}

export function capacityBudget(capacity: number, budget: CapacityBudget): number {
	const scaled = (capacity * (budget.multiplier ?? 1)) / budget.divisor;
	const value = budget.rounding === "ceil" ? Math.ceil(scaled) : Math.floor(scaled);

	return clamp(value + (budget.offset ?? 0), budget.min, budget.max);
}

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
		ffmpegThreads: settings.ffmpegThreads ?? capacityBudget(effectiveCores, { divisor: 3, min: 1, max: CAPS.ffmpegThreads }),
		sharpConcurrency: capacityBudget(capacity, { divisor: 2, min: 1, max: CAPS.sharpConcurrency }),
		workerPoolMaxConcurrent:
			settings.poolMaxConcurrent ?? capacityBudget(capacity, { divisor: 1, min: 3, max: CAPS.poolMax, multiplier: 1.25 }),
		scannerConcurrency: capacityBudget(capacity, { divisor: 2, min: 1, max: CAPS.scannerConcurrency }),
		ffprobeConcurrency: capacityBudget(capacity, { divisor: 2, min: 1, max: CAPS.ffprobeConcurrency }),
	};
}

function resolveReservedWebCores(profile: CpuProfile, effectiveCores: number, speedFactor: number, customSetting?: number): number {
	if (profile === "custom" && customSetting !== undefined) {
		return clamp(customSetting, 1, Math.max(1, effectiveCores - 1));
	}

	if (profile === "performance") {
		if (effectiveCores > 2) return clamp(Math.floor(effectiveCores * PROFILE_RESERVE_RATIO.performance), 1, effectiveCores);

		return 1;
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
	return capacityBudget(capacity, { divisor: 3, min: 1, max: CAPS.heavySubprocess });
}

/** Parallel file-system fan-outs (stat/unlink/read sweeps). Slow storage
 * (NAS, SD card) suffers as much from deep queues as a slow CPU does from
 * extra ffmpeg processes, so this scales with capacity too. */
export function ioConcurrency(capacity: number): number {
	return capacityBudget(capacity, { divisor: 1, min: 4, max: CAPS.ioConcurrency, multiplier: 2 });
}

/**
 * How many trickplay sprite grids may render at once. A grid is a background
 * CPU job — it decodes a row of seeks from the source — so the budget comes
 * from the cores left after the web reserve, halved because one grid already
 * fans out over many seeks.
 */
export function trickplayConcurrency(backgroundBudgetCores: number): number {
	return capacityBudget(backgroundBudgetCores, { divisor: 2, min: 1, max: CAPS.trickplay });
}

/** media-file-ingest tasks each run an ffprobe plus catalog writes. */
export function ingestConcurrency(capacity: number): number {
	return capacityBudget(capacity, { divisor: 2, min: 1, max: 3 });
}

/**
 * Concurrent software video transcodes. Each one burns a full CPU budget, and
 * on a slow box four of them starve HTTP and the database. Hardware transcodes
 * and direct-stream remuxes are not counted by this limit.
 */
export function softwareTranscodeConcurrency(capacity: number): number {
	return capacityBudget(capacity, { divisor: 1, min: 1, max: CAPS.softwareTranscode, offset: 1 });
}

/** Heavy chunked relation queries fan out per metadata id — catalog reads,
 * same budget class as ingest, derived from measured capacity. */
export function relationQueryConcurrency(capacity: number): number {
	return capacityBudget(capacity, { divisor: 2, min: 1, max: 8, rounding: "ceil" });
}

/** Auto concurrency for a worker by its canonical id; unbudgeted workers get 1. */
export function workerAutoConcurrency(workerId: string, capacity: number): number {
	const mappedId = canonicalWorkerId(workerId);
	if (!(mappedId && isBudgetedWorker(mappedId))) return 1;

	return capacityBudget(capacity, WORKER_BUDGET_RATIO[mappedId]);
}

/**
 * A value that scales with installed memory: `perGb` for each GiB of RAM,
 * clamped to [min, max]. Unknown RAM → `min`, so a cache we cannot size is
 * never over-allocated.
 */
export function ramScaled(totalKiB: number | undefined, perGb: number, min: number, max: number): number {
	if (totalKiB === undefined) return min;

	const memGb = totalKiB / MIB;

	return clamp(Math.floor(memGb * perGb), min, max);
}
