import { describe, expect, test } from "bun:test";
import type { SystemSettingKey } from "@/config/system-settings.definition";
import { systemSettingsStore } from "@/config/system-settings.store";
import { SystemResourcesService, scaleTimeoutMsForFactor, systemResourcesService } from "./system-resources.service";

/** Installs runtime overrides, runs the body, always restores the store. */
function withSettings(values: Partial<Record<SystemSettingKey, unknown>>, run: () => void): void {
	try {
		systemSettingsStore.setRuntimeValues(values);
		run();
	} finally {
		systemSettingsStore.clearRuntimeValues();
	}
}

describe("SystemResourcesService sizing formulas (injected hardware)", () => {
	test("derives every budget from effectiveCores × speedFactor", () => {
		// [cores, speedFactor, profile, expected budgets]
		interface ExpectedBudgets {
			capacity: number;
			reserved: number;
			background: number;
			ffmpeg: number;
			sharp: number;
			scanner: number;
			ffprobe: number;
			pool: number;
		}
		const table: ReadonlyArray<[number, number, "balanced" | "conservative" | "performance", ExpectedBudgets]> = [
			// 2 fast cores: floor(2/3)=0 threads → clamp to 1; pool floor hits the 3 minimum.
			[2, 1.0, "balanced", { capacity: 2, reserved: 1, background: 1, ffmpeg: 1, sharp: 1, scanner: 1, ffprobe: 1, pool: 3 }],
			// 4 fast cores: balanced reserve ceil(4×0.33)=2.
			[4, 1.0, "balanced", { capacity: 4, reserved: 2, background: 2, ffmpeg: 1, sharp: 2, scanner: 2, ffprobe: 2, pool: 5 }],
			// 8 slow cores: balanced auto-downgrades to conservative reserve ceil(8×0.5)=4.
			[8, 0.5, "balanced", { capacity: 4, reserved: 4, background: 4, ffmpeg: 2, sharp: 2, scanner: 2, ffprobe: 2, pool: 5 }],
			// 16 very fast cores: subprocess budgets hit their caps, not capacity.
			[16, 1.5, "balanced", { capacity: 24, reserved: 6, background: 10, ffmpeg: 5, sharp: 4, scanner: 6, ffprobe: 3, pool: 12 }],
			// 32 slowest cores: threads cap at 8, pool at 12.
			[32, 0.35, "balanced", { capacity: 11, reserved: 16, background: 16, ffmpeg: 8, sharp: 4, scanner: 5, ffprobe: 3, pool: 12 }],
			// Explicit conservative keeps the 50% reserve even on fast cores.
			[8, 1.0, "conservative", { capacity: 8, reserved: 4, background: 4, ffmpeg: 2, sharp: 4, scanner: 4, ffprobe: 3, pool: 10 }],
			// Performance reserve floor(eff×0.15), minimum 1.
			[8, 1.0, "performance", { capacity: 8, reserved: 1, background: 7, ffmpeg: 2, sharp: 4, scanner: 4, ffprobe: 3, pool: 10 }],
		];

		for (const [cores, speedFactor, profile, expected] of table) {
			const service = new SystemResourcesService({ cores: () => cores, speedFactor: () => speedFactor });
			withSettings({ "system.resources.cpuProfile": profile }, () => {
				const metrics = service.getMetrics();

				expect(metrics.detectedCores).toBe(cores);
				expect(metrics.effectiveCores).toBe(cores);
				expect(metrics.speedFactor).toBe(speedFactor);
				expect(metrics.capacity).toBe(expected.capacity);
				expect(metrics.reservedWebCores).toBe(expected.reserved);
				expect(metrics.backgroundBudgetCores).toBe(expected.background);
				expect(metrics.ffmpegThreads).toBe(expected.ffmpeg);
				expect(metrics.sharpConcurrency).toBe(expected.sharp);
				expect(metrics.scannerConcurrency).toBe(expected.scanner);
				expect(metrics.ffprobeConcurrency).toBe(expected.ffprobe);
				expect(metrics.workerPoolMaxConcurrent).toBe(expected.pool);
			});
		}
	});

	test("admin numeric overrides always win over the derivation", () => {
		// Regression: readPositiveNumber treated number-typed runtime values as
		// invalid, silently discarding every admin override.
		const service = new SystemResourcesService({ cores: () => 16, speedFactor: () => 1.0 });
		withSettings(
			{
				"system.resources.maxCpuCores": 4,
				"system.resources.ffmpegMaxThreads": 2,
				"system.resources.workerPoolMaxConcurrent": 6,
				"system.resources.cpuProfile": "custom",
				"system.resources.reservedCoresForWeb": 1,
			},
			() => {
				const metrics = service.getMetrics();

				expect(metrics.configuredMaxCores).toBe(4);
				expect(metrics.effectiveCores).toBe(4);
				expect(metrics.ffmpegThreads).toBe(2);
				expect(metrics.workerPoolMaxConcurrent).toBe(6);
				expect(metrics.reservedWebCores).toBe(1);
			},
		);
	});

	test("custom reserve clamps to [1, effectiveCores - 1]", () => {
		const service = new SystemResourcesService({ cores: () => 4, speedFactor: () => 1.0 });
		withSettings({ "system.resources.cpuProfile": "custom", "system.resources.reservedCoresForWeb": 10 }, () => {
			expect(service.getMetrics().reservedWebCores).toBe(3);
		});
		service.clearMetricsCache();
		withSettings({ "system.resources.cpuProfile": "custom", "system.resources.reservedCoresForWeb": 1 }, () => {
			expect(service.getMetrics().reservedWebCores).toBe(1);
		});
	});

	test("performance profile keeps minimum 1 reserve on tiny machines", () => {
		const service = new SystemResourcesService({ cores: () => 2, speedFactor: () => 1.0 });
		withSettings({ "system.resources.cpuProfile": "performance" }, () => {
			expect(service.getMetrics().reservedWebCores).toBe(1);
		});
	});

	test("slow cores get image effort 4, fast cores 5", () => {
		expect(new SystemResourcesService({ cores: () => 4, speedFactor: () => 0.5 }).getImageEffort()).toBe(4);
		expect(new SystemResourcesService({ cores: () => 4, speedFactor: () => 1.0 }).getImageEffort()).toBe(5);
	});

	test("worker auto-concurrency scales with capacity, not thread count", () => {
		// capacity = 4 (4 cores × 1.0).
		const service = new SystemResourcesService({ cores: () => 4, speedFactor: () => 1.0 });
		expect(service.getWorkerAutoConcurrency("image-processing")).toBe(2);
		expect(service.getWorkerAutoConcurrency("imageOptimization")).toBe(2);
		expect(service.getWorkerAutoConcurrency("metadata-refresh")).toBe(2);
		expect(service.getWorkerAutoConcurrency("media-file-technical-refresh")).toBe(1);
		expect(service.getWorkerAutoConcurrency("media-file-analysis")).toBe(1);
		expect(service.getWorkerAutoConcurrency("unknown-worker")).toBe(1);
	});

	test("RAM-scaled budgets stay within their clamps on any machine", () => {
		const service = new SystemResourcesService();
		const inflight = service.getMaxInflightResponses();
		expect(inflight).toBeGreaterThanOrEqual(32);
		expect(inflight).toBeLessThanOrEqual(256);

		const entries = service.getRamScaledCacheEntries(12, 25, 100);
		expect(entries).toBeGreaterThanOrEqual(25);
		expect(entries).toBeLessThanOrEqual(100);
	});

	test("totalMemoryKiB override drives RAM-scaled cache and inflight budgets", () => {
		// 4 GB RAM = 4 * 1024 * 1024 KiB
		const lowMemService = new SystemResourcesService({ totalMemoryKiB: () => 4 * 1024 * 1024 });
		expect(lowMemService.getTotalMemoryKiB()).toBe(4 * 1024 * 1024);
		// 4 GB * 32 = 128 max in flight responses
		expect(lowMemService.getMaxInflightResponses()).toBe(128);
		// 4 GB * 10 = 40 entries
		expect(lowMemService.getRamScaledCacheEntries(10, 20, 200)).toBe(40);

		// 32 GB RAM = 32 * 1024 * 1024 KiB
		const highMemService = new SystemResourcesService({ totalMemoryKiB: () => 32 * 1024 * 1024 });
		// 32 GB * 32 = 1024 -> clamped to 256
		expect(highMemService.getMaxInflightResponses()).toBe(256);
	});
});

describe("scaleTimeoutMsForFactor", () => {
	test("fast cores keep the base timeout", () => {
		expect(scaleTimeoutMsForFactor(10_000, 1.0)).toBe(10_000);
		// Above 1.0 clamps to the base — fast machines must not shrink budgets.
		expect(scaleTimeoutMsForFactor(10_000, 1.5)).toBe(10_000);
	});

	test("slow cores get up to 2× headroom", () => {
		expect(scaleTimeoutMsForFactor(10_000, 0.5)).toBe(15_000);
		expect(scaleTimeoutMsForFactor(10_000, 0.35)).toBe(16_500);
		expect(scaleTimeoutMsForFactor(10_000, 0.0)).toBe(20_000);
	});
});

describe("SystemResourcesService real detection (self-consistency only)", () => {
	test("singleton metrics are internally consistent on any machine", () => {
		const metrics = systemResourcesService.getMetrics();

		expect(metrics.detectedCores).toBeGreaterThanOrEqual(1);
		expect(metrics.effectiveCores).toBeGreaterThanOrEqual(1);
		expect(metrics.effectiveCores).toBeLessThanOrEqual(metrics.detectedCores);
		expect(metrics.speedFactor).toBeGreaterThanOrEqual(0.35);
		expect(metrics.speedFactor).toBeLessThanOrEqual(1.5);
		expect(metrics.capacity).toBe(Math.max(1, Math.round(metrics.effectiveCores * metrics.speedFactor)));
		expect(metrics.reservedWebCores).toBeGreaterThanOrEqual(1);
		expect(metrics.backgroundBudgetCores).toBeGreaterThanOrEqual(1);
	});
});
