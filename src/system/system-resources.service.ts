import { readFileSync } from "node:fs";
import { availableParallelism, cpus } from "node:os";
import type { Logger } from "@reelvault/sdk/common";
import { systemSettingsStore } from "@/config/system-settings.store";
import type { CpuProfile } from "@/config/system-settings.types";
import { createLogger } from "@/utils/logger";
import { clamp } from "@/utils/math.utils";
import { getTotalMemoryKiB } from "@/utils/mem.utils";
import { isFiniteNumber, isNonEmptyString } from "@/utils/type.utils";
import { type CanonicalWorkerId, canonicalWorkerId } from "@/workers/worker-ids";

type WorkerId = "image-processing" | "metadata-refresh" | "media-file-technical-refresh" | "media-file-analysis";

interface CpuResourceMetrics {
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
}

/**
 * Test seams for hardware detection: injecting them makes the sizing formulas
 * verifiable without depending on the machine running the tests. The default
 * (empty) overrides keep the real detection + benchmark paths.
 */
export interface SystemResourcesOverrides {
	/** Fixed available-core count; skips os/cgroup/cpuset detection entirely. */
	readonly cores?: () => number;
	/** Fixed single-core speed factor (0-∞; clamped like a real measurement). */
	readonly speedFactor?: () => number;
	/** Fixed total memory in KiB; skips os/cgroup/meminfo detection. */
	readonly totalMemoryKiB?: () => number;
}

/** Pure core of {@link SystemResourcesService.scaledTimeoutMs}: fast cores
 * keep the base, slow cores get up to 2× headroom. */
export function scaleTimeoutMsForFactor(baseMs: number, speedFactor: number): number {
	return Math.round(baseMs * clamp(2 - speedFactor, 1, 2));
}

const CPU_PROFILES = new Set<string>(["conservative", "balanced", "performance", "custom"]);
const WHITESPACE_REGEX = /\s+/;

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
const SLOW_CORE_FACTOR = 0.7;

// Single-core score of a modern desktop core in benchmark iterations per ms
// (see runCpuBenchmark). Calibrated on Zen-class hardware; older server CPUs
// (Xeon E5 class, ARM SBCs) measure roughly 0.35-0.6 of it.
const SPEED_REFERENCE_ITERATIONS_PER_MS = 260_000;
const SPEED_FACTOR_MIN = 0.35;
const SPEED_FACTOR_MAX = 1.5;

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

const METRICS_TTL_MS = 1500;

/** Parses a setting into a positive finite number, or returns undefined.
 * Accepts both numbers (runtime store keeps parsed values) and numeric
 * strings (wire format) — a number-only check silently dropped every
 * admin override, and a string-only check would drop runtime values. */
function readPositiveNumber(raw: unknown): number | undefined {
	let value = Number.NaN;
	if (typeof raw === "number") {
		value = raw;
	} else if (isNonEmptyString(raw)) {
		value = Number(raw);
	}

	return isFiniteNumber(value) && value > 0 ? value : undefined;
}

function isCpuProfile(value: string): value is CpuProfile {
	return CPU_PROFILES.has(value);
}

function isReservedProfile(value: CpuProfile): value is Exclude<CpuProfile, "custom"> {
	return isCpuProfile(value) && value !== "custom";
}

function readCpuProfile(raw: unknown): CpuProfile {
	return typeof raw === "string" && isCpuProfile(raw) ? raw : "balanced";
}

function parseCgroupQuotaCores(quotaStr: string, periodStr: string): number | undefined {
	const quota = Number.parseInt(quotaStr, 10);
	const period = Number.parseInt(periodStr, 10);
	if (!(quota > 0 && period > 0)) return undefined;

	return Math.max(1, Math.floor(quota / period));
}

/** Counts CPUs listed in a cpuset string like "0-3,7,9-10". */
function parseCpusetCores(raw: string): number | undefined {
	if (!isNonEmptyString(raw)) return undefined;

	const trimmed = raw.trim();

	let count = 0;
	for (const part of trimmed.split(",")) {
		const [startStr, endStr] = part.split("-");
		if (!startStr) continue;

		const start = Number.parseInt(startStr, 10);
		const end = endStr ? Number.parseInt(endStr, 10) : start;

		if (isFiniteNumber(start) && isFiniteNumber(end) && end >= start) {
			count += end - start + 1;
		}
	}

	return count > 0 ? count : undefined;
}

/** Narrowing guard: only the budgeted workers have a ratio entry. */
function isBudgetedWorker(id: CanonicalWorkerId): id is WorkerId {
	return id in WORKER_BUDGET_RATIO;
}

export class SystemResourcesService {
	private cachedHardwareCores?: number | undefined;
	private cachedSpeedFactor?: number | undefined;
	private cachedMetrics?: { metrics: CpuResourceMetrics; expiresAt: number } | undefined;
	private readonly overrides: SystemResourcesOverrides;

	constructor(overrides: SystemResourcesOverrides = {}) {
		this.overrides = overrides;
	}

	// Lazy logger: instantiating services at module scope must not execute
	// logger machinery while an import cycle is still mid-evaluation.
	private lazyLogger?: Logger | undefined;
	private get logger(): Logger {
		this.lazyLogger ??= createLogger("SystemResourcesService");

		return this.lazyLogger;
	}

	clearMetricsCache(): void {
		this.cachedMetrics = undefined;
		this.logger.debug("System resource metrics cache cleared");
	}

	/**
	 * Single-core speed vs a modern desktop core, measured once per process.
	 * Twelve slow threads must not fund twelve modern-core budgets — subprocess
	 * parallelism scales with capacity, not with raw thread count. A noisy
	 * measurement fails safe: a low factor shrinks background budgets.
	 */
	getSpeedFactor(): number {
		if (this.cachedSpeedFactor !== undefined) return this.cachedSpeedFactor;

		if (this.overrides.speedFactor) {
			this.cachedSpeedFactor = clamp(this.overrides.speedFactor(), SPEED_FACTOR_MIN, SPEED_FACTOR_MAX);

			return this.cachedSpeedFactor;
		}

		let factor = 1;
		try {
			factor = this.measureSpeedFactor();
		} catch (error) {
			this.logger.warn("CPU speed benchmark failed — assuming modern core", { error });
		}

		this.cachedSpeedFactor = factor;
		this.logger.info("CPU speed factor measured", { speedFactor: factor });

		return factor;
	}

	private measureSpeedFactor(): number {
		const warmup = this.runBenchmarkRound(50_000);
		let iterations = Math.max(50_000, Math.floor((warmup.iterations / Math.max(warmup.elapsedMs, 0.1)) * 8));
		iterations = Math.min(iterations, 8_000_000);
		let best = Number.POSITIVE_INFINITY;
		for (let round = 0; round < 2; round++) {
			const sample = this.runBenchmarkRound(iterations);
			best = Math.min(best, sample.elapsedMs);
		}

		const scorePerMs = iterations / Math.max(best, 0.1);

		return clamp(scorePerMs / SPEED_REFERENCE_ITERATIONS_PER_MS, SPEED_FACTOR_MIN, SPEED_FACTOR_MAX);
	}

	private runBenchmarkRound(iterations: number): { iterations: number; elapsedMs: number } {
		const start = performance.now();
		let acc = 0;
		for (let i = 1; i <= iterations; i++) {
			acc = (acc + Math.imul(i, 2654435761)) % 2147483647;
			// Keep string machinery inside the measured work — server workloads
			// are JSON/string-heavy, not pure integer math.
			if ((i & 8191) === 0) acc += i.toString().length;
		}

		// Defeat dead-code elimination in optimising runtimes.
		if (acc === -1) throw new Error("benchmark accumulator overflow");

		return { iterations, elapsedMs: performance.now() - start };
	}

	/**
	 * Detects CPU cores available to the process, accounting for cgroup v1/v2
	 * quota AND cpuset limits (Proxmox LXC, Docker, Kubernetes commonly pin cpuset).
	 */
	detectAvailableCores(): number {
		if (this.cachedHardwareCores !== undefined) {
			return this.cachedHardwareCores;
		}

		if (this.overrides.cores) {
			const injected = Math.max(1, this.overrides.cores());
			this.cachedHardwareCores = injected;

			return injected;
		}

		let detected: number;
		try {
			detected = availableParallelism();
		} catch {
			detected = cpus().length;
			this.logger.debug("availableParallelism failed, falling back to CPU count", { detectedCores: detected });
		}

		const quotaCores = this.readCgroupQuotaCores();
		if (quotaCores !== undefined) {
			detected = Math.min(detected, quotaCores);
			this.logger.debug("Applied cgroup CPU quota", { quotaCores, detectedCores: detected });
		}

		const cpusetCores = this.readCpusetCores();
		if (cpusetCores !== undefined) {
			detected = Math.min(detected, cpusetCores);
			this.logger.debug("Applied cpuset CPU limit", { cpusetCores, detectedCores: detected });
		}

		const finalCores = Math.max(1, detected || 1);
		this.cachedHardwareCores = finalCores;
		this.logger.debug("Available CPU cores detected", { finalCores });

		return finalCores;
	}

	private readCgroupQuotaCores(): number | undefined {
		try {
			const [quotaStr, periodStr] = readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim().split(WHITESPACE_REGEX);
			if (quotaStr && quotaStr !== "max" && periodStr) {
				return parseCgroupQuotaCores(quotaStr, periodStr);
			}

			return undefined;
		} catch {
			try {
				const quotaStr = readFileSync("/sys/fs/cgroup/cpu/cpu.cfs_quota_us", "utf8").trim();
				const periodStr = readFileSync("/sys/fs/cgroup/cpu/cpu.cfs_period_us", "utf8").trim();
				const quotaCores = parseCgroupQuotaCores(quotaStr, periodStr);
				if (quotaCores !== undefined) this.logger.debug("Read cgroup v1 CPU quota", { quotaCores });

				return quotaCores;
			} catch {
				return undefined;
			}
		}
	}

	private readCpusetCores(): number | undefined {
		for (const path of ["/sys/fs/cgroup/cpuset.cpus.effective", "/sys/fs/cgroup/cpuset/cpuset.cpus"]) {
			try {
				const raw = readFileSync(path, "utf8");
				const cores = parseCpusetCores(raw);
				if (cores !== undefined) {
					this.logger.debug("Read cpuset CPU limit", { path, cores });

					return cores;
				}
			} catch {
				// try next path
			}
		}

		return undefined;
	}

	getMetrics(): CpuResourceMetrics {
		const now = Date.now();
		if (this.cachedMetrics && this.cachedMetrics.expiresAt > now) {
			return this.cachedMetrics.metrics;
		}

		const detectedCores = this.detectAvailableCores();
		const cpuProfile = readCpuProfile(systemSettingsStore.get("system.resources.cpuProfile"));
		const configuredMaxSetting = readPositiveNumber(systemSettingsStore.get("system.resources.maxCpuCores"));
		const configuredReservedSetting = readPositiveNumber(systemSettingsStore.get("system.resources.reservedCoresForWeb"));
		const configuredFfmpegThreads = readPositiveNumber(systemSettingsStore.get("system.resources.ffmpegMaxThreads"));
		const configuredPoolMax = readPositiveNumber(systemSettingsStore.get("system.resources.workerPoolMaxConcurrent"));

		const configuredMaxCores = configuredMaxSetting ?? detectedCores;
		const effectiveCores = clamp(Math.min(detectedCores, configuredMaxCores), 1, detectedCores);

		const speedFactor = this.getSpeedFactor();
		const capacity = Math.max(1, Math.round(effectiveCores * speedFactor));

		const reservedWebCores = this.resolveReservedWebCores(cpuProfile, effectiveCores, speedFactor, configuredReservedSetting);
		const backgroundBudgetCores = Math.max(1, effectiveCores - reservedWebCores);

		// One transcode must not eat the whole machine: ~⅓ of the threads per
		// FFmpeg process leaves the rest for HTTP and other sessions.
		const ffmpegThreads = configuredFfmpegThreads ?? clamp(Math.floor(effectiveCores / 3), 1, CAPS.ffmpegThreads);
		const sharpConcurrency = clamp(Math.floor(capacity / 2), 1, CAPS.sharpConcurrency);
		const workerPoolMaxConcurrent = configuredPoolMax ?? clamp(Math.floor(capacity * 1.25), 3, CAPS.poolMax);
		const scannerConcurrency = clamp(Math.floor(capacity / 2), 1, CAPS.scannerConcurrency);
		const ffprobeConcurrency = clamp(Math.floor(capacity / 2), 1, CAPS.ffprobeConcurrency);

		const metrics: CpuResourceMetrics = Object.freeze({
			detectedCores,
			configuredMaxCores,
			effectiveCores,
			speedFactor,
			capacity,
			reservedWebCores,
			backgroundBudgetCores,
			cpuProfile,
			ffmpegThreads,
			sharpConcurrency,
			workerPoolMaxConcurrent,
			scannerConcurrency,
			ffprobeConcurrency,
		});

		this.cachedMetrics = { metrics, expiresAt: now + METRICS_TTL_MS };
		this.logger.debug("System resource metrics calculated", { metrics });

		return metrics;
	}

	private resolveReservedWebCores(profile: CpuProfile, effectiveCores: number, speedFactor: number, customSetting?: number): number {
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

	getFfmpegThreads(): number {
		return this.getMetrics().ffmpegThreads;
	}

	getSharpConcurrency(): number {
		return this.getMetrics().sharpConcurrency;
	}

	/** How many CPU-heavy subprocesses (parallel ffmpeg decodes, test encodes)
	 * may run at once, derived from capacity instead of raw thread count. */
	getHeavySubprocessConcurrency(): number {
		const { capacity } = this.getMetrics();

		return clamp(Math.floor(capacity / 3), 1, CAPS.heavySubprocess);
	}

	/** webp encoder effort: slow cores get faster (bigger) output for the same
	 * wall-clock time on the inline image-optimization path. */
	getImageEffort() {
		return this.getSpeedFactor() < SLOW_CORE_FACTOR ? 4 : 5;
	}

	getWorkerPoolMaxConcurrent(): number {
		return this.getMetrics().workerPoolMaxConcurrent;
	}

	/** Parallel file-system fan-outs (stat/unlink/read sweeps). Slow storage
	 * (NAS, SD card) suffers as much from deep queues as a slow CPU does from
	 * extra ffmpeg processes, so this scales with capacity too. */
	getIoConcurrency(): number {
		const { capacity } = this.getMetrics();

		return clamp(Math.floor(capacity * 2), 4, CAPS.ioConcurrency);
	}

	/** media-file-ingest tasks each run an ffprobe plus catalog writes. */
	getIngestConcurrency(): number {
		const { capacity } = this.getMetrics();

		return clamp(Math.floor(capacity / 2), 1, 3);
	}

	/** How many large serialized responses request-dedup may hold in RAM at
	 * once — on a 4 GB box a catalog-response stampede at 256 in-flight bodies
	 * is an OOM vector, so the cap scales with installed memory. */
	getMaxInflightResponses(): number {
		const totalKiB = this.getTotalMemoryKiB();
		// Unknown RAM → fail safe at the floor, not the ceiling (a 4 GB box must
		// not inherit an 8 GB box's in-flight budget).
		if (totalKiB === undefined) return 32;

		const memGb = totalKiB / 1024 / 1024;

		return clamp(Math.floor(memGb * 32), 32, 256);
	}

	/** Total RAM in KiB, read once per process (installed memory never changes).
	 * Cached because this getter sits on per-request paths (e.g. dedup cap) —
	 * an uncached /proc read blocked the event loop on every dedup-enabled GET. */
	getTotalMemoryKiB(): number | undefined {
		if (this.overrides.totalMemoryKiB) {
			return this.overrides.totalMemoryKiB();
		}

		return getTotalMemoryKiB();
	}

	/** Entries a RAM-held cache may hold: scales with installed memory so a
	 * cache sized for 8 GB doesn't starve a 4 GB box (nor underuse a 32 GB one). */
	getRamScaledCacheEntries(gbMultiplier: number, min: number, max: number): number {
		const totalKiB = this.getTotalMemoryKiB();
		// Unknown RAM → smallest budget (never over-allocate a cache we can't size).
		if (totalKiB === undefined) return min;

		const memGb = totalKiB / 1024 / 1024;

		return clamp(Math.floor(memGb * gbMultiplier), min, max);
	}

	/** Wall-clock budgets need headroom on slow single cores: a fixed 15 s
	 * timeout that is generous on a modern CPU fires spuriously on E5/RPi-class
	 * hardware. Fast boxes keep the base (failure detection must not rot);
	 * slow boxes get up to 2×. */
	scaledTimeoutMs(baseMs: number): number {
		return scaleTimeoutMsForFactor(baseMs, this.getSpeedFactor());
	}

	getScannerConcurrency(): number {
		return readPositiveNumber(systemSettingsStore.get("scanning.concurrency")) ?? this.getMetrics().scannerConcurrency;
	}

	getFfprobeConcurrency(): number {
		return readPositiveNumber(systemSettingsStore.get("scanning.ffprobeConcurrency")) ?? this.getMetrics().ffprobeConcurrency;
	}

	getWorkerAutoConcurrency(workerId: string): number {
		const { capacity } = this.getMetrics();

		const mappedId = canonicalWorkerId(workerId);
		if (!(mappedId && isBudgetedWorker(mappedId))) return 1;

		return WORKER_BUDGET_RATIO[mappedId](capacity);
	}
}

export const systemResourcesService = new SystemResourcesService();
