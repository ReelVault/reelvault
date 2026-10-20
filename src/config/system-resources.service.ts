import type { Logger } from "@reelvault/sdk/common";
import { env } from "@/config/env.config";
import { systemSettingsStore } from "@/config/system-settings.store";
import { EventLoopMonitor } from "@/utils/event-loop-monitor.utils";
import { createLogger } from "@/utils/logger.utils";
import { clamp } from "@/utils/math.utils";
import { getTotalMemoryKiB } from "@/utils/mem.utils";
import { clampSpeedFactor, measureSpeedFactor } from "./system-resources/benchmark.utils";
import {
	type CpuResourceMetrics,
	deriveCpuMetrics,
	heavySubprocessConcurrency,
	ingestConcurrency,
	ioConcurrency,
	ramScaled,
	relationQueryConcurrency,
	SLOW_CORE_FACTOR,
	softwareTranscodeConcurrency,
	trickplayConcurrency,
	workerAutoConcurrency,
} from "./system-resources/budgets.utils";
import { detectHostCores } from "./system-resources/hardware.utils";
import { readCpuSettings, readPositiveNumber } from "./system-resources/settings.reader";

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
export function timeoutMultiplierForFactor(speedFactor: number): number {
	return clamp(2 - speedFactor, 1, 2);
}

export function scaleTimeoutMsForFactor(baseMs: number, speedFactor: number): number {
	return Math.round(baseMs * timeoutMultiplierForFactor(speedFactor));
}

const METRICS_TTL_MS = 1500;

export class SystemResourcesService {
	private cachedHardwareCores?: number | undefined;
	private cachedSpeedFactor?: number | undefined;
	private cachedMetrics?: { metrics: CpuResourceMetrics; expiresAt: number } | undefined;
	private readonly overrides: SystemResourcesOverrides;
	/** Samples loop stalls so each metrics snapshot reports utilization over its window.
	 * A 1 s cadence still catches stalls (lateness accumulates as `now - expected`)
	 * while cutting idle timer wakeups 10× vs the previous 100 ms probe. */
	private readonly eventLoopMonitor = new EventLoopMonitor(1000);

	constructor(overrides: SystemResourcesOverrides = {}) {
		const cores = env.REELVAULT_BENCH_CORES;
		const speedFactor = env.REELVAULT_BENCH_SPEED_FACTOR;
		const totalMemoryKiB = env.REELVAULT_BENCH_TOTAL_MEMORY_KIB;
		const simulated: SystemResourcesOverrides = {
			...(cores === undefined ? {} : { cores: () => cores }),
			...(speedFactor === undefined ? {} : { speedFactor: () => speedFactor }),
			...(totalMemoryKiB === undefined ? {} : { totalMemoryKiB: () => totalMemoryKiB }),
		};
		// Explicit test seams win over the benchmark environment.
		this.overrides = { ...simulated, ...overrides };
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
			this.cachedSpeedFactor = clampSpeedFactor(this.overrides.speedFactor());

			return this.cachedSpeedFactor;
		}

		let factor = 1;
		try {
			factor = measureSpeedFactor();
		} catch (error) {
			this.logger.warn("CPU speed benchmark failed — assuming modern core", { error });
		}

		this.cachedSpeedFactor = factor;
		this.logger.info("CPU speed factor measured", { speedFactor: factor });

		return factor;
	}

	/**
	 * Detects CPU cores available to the process, accounting for cgroup v1/v2
	 * quota AND cpuset limits.
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

		const finalCores = detectHostCores(this.logger);
		this.cachedHardwareCores = finalCores;
		this.logger.debug("Available CPU cores detected", { finalCores });

		return finalCores;
	}

	getMetrics(): CpuResourceMetrics {
		const now = Date.now();
		if (this.cachedMetrics && this.cachedMetrics.expiresAt > now) {
			return this.cachedMetrics.metrics;
		}

		const derived = deriveCpuMetrics(this.detectAvailableCores(), readCpuSettings(), this.getSpeedFactor());
		// Utilization over THIS snapshot window (the metrics TTL): a saturated
		// single loop shows up as ~1.0 even when CPU% looks idle on many cores.
		const eventLoopUtilization = this.eventLoopMonitor.read();
		const metrics: CpuResourceMetrics = Object.freeze({
			...derived,
			...(eventLoopUtilization === undefined ? {} : { eventLoopUtilization }),
		});

		this.cachedMetrics = { metrics, expiresAt: now + METRICS_TTL_MS };
		this.logger.debug("System resource metrics calculated", { metrics });

		return metrics;
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
		return heavySubprocessConcurrency(this.getMetrics().capacity);
	}

	/** webp encoder effort: slow cores get faster (bigger) output for the same
	 * wall-clock time on the inline image-optimization path. */
	getImageEffort() {
		return this.getSpeedFactor() < SLOW_CORE_FACTOR ? 4 : 5;
	}

	getWorkerPoolMaxConcurrent(): number {
		return this.getMetrics().workerPoolMaxConcurrent;
	}

	/** Parallel file-system fan-outs (stat/unlink/read sweeps). */
	getIoConcurrency(): number {
		return ioConcurrency(this.getMetrics().capacity);
	}

	/** Trickplay sprite grids rendering at once — background CPU budget, so the
	 * web reserve is already subtracted. */
	getTrickplayConcurrency(): number {
		return trickplayConcurrency(this.getMetrics().backgroundBudgetCores);
	}

	/** media-file-ingest tasks each run an ffprobe plus catalog writes. */
	getIngestConcurrency(): number {
		return ingestConcurrency(this.getMetrics().capacity);
	}

	/** Software video transcodes that may run at once before HTTP loses its cores. */
	getSoftwareTranscodeConcurrency(): number {
		return softwareTranscodeConcurrency(this.getMetrics().capacity);
	}

	/** Heavy chunked relation queries fan out per metadata id, sized from measured capacity. */
	getRelationQueryConcurrency(): number {
		return relationQueryConcurrency(this.getMetrics().capacity);
	}

	/** How many large serialized responses request-dedup may hold in RAM at
	 * once — on a 4 GB box a catalog-response stampede at 256 in-flight bodies
	 * is an OOM vector, so the cap scales with installed memory. */
	getMaxInflightResponses(): number {
		return ramScaled(this.getTotalMemoryKiB(), 32, 32, 256);
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

	/**
	 * A value that scales with installed memory: `perUnit` for each GiB of RAM,
	 * clamped to [min, max]. The unit is the caller's — entries for a cache
	 * size, bytes for a byte budget.
	 */
	getRamScaled(perUnit: number, min: number, max: number): number {
		return ramScaled(this.getTotalMemoryKiB(), perUnit, min, max);
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
		return workerAutoConcurrency(workerId, this.getMetrics().capacity);
	}
}

export const systemResourcesService = new SystemResourcesService();
