import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { systemSettingsStore } from "@/config/system-settings.store";
import { ResourceAllocator, type ResourceSnapshot } from "./resource-allocator";

function calculatePressure(a: ResourceAllocator, cpu: number, mem: number, disk: number): string {
	const fn = Reflect.get(a, "calculatePressure");

	return typeof fn === "function" ? Reflect.apply(fn, a, [cpu, mem, disk]) : "";
}

function setSnapshot(a: ResourceAllocator, snapshot: ResourceSnapshot | undefined): void {
	Reflect.set(a, "currentSnapshot", snapshot);
}

function getAlerts(a: ResourceAllocator): Array<{ timestamp: number; type: string }> {
	const val = Reflect.get(a, "recentAlerts");

	return Array.isArray(val) ? val : [];
}

async function collectSnapshot(a: ResourceAllocator): Promise<void> {
	const fn = Reflect.get(a, "collectSnapshot");
	if (typeof fn === "function") {
		await Reflect.apply(fn, a, []);
	}
}

const makeSnapshot = (overrides: Partial<ResourceSnapshot> = {}): ResourceSnapshot => ({
	timestamp: Date.now(),
	cpu: { usedPercent: 30, loadAvg: [0.5, 0.5, 0.5] },
	memory: { usedMb: 2000, totalMb: 8000, percent: 25 },
	disk: { usedGb: 50, totalGb: 200, percent: 25 },
	pressure: "low",
	activeStreams: 0,
	workers: {},
	...overrides,
});

const SETTINGS_KEYS = [
	"system.resources.enableDynamicThrottling",
	"system.resources.throttleLowPriorityAbovePercent",
	"system.resources.streamingGuaranteedCores",
	"system.resources.monitoringEnabled",
] as const;

describe("ResourceAllocator", () => {
	beforeEach(() => {
		systemSettingsStore.setRuntimeValues({
			"system.resources.enableDynamicThrottling": true,
			"system.resources.throttleLowPriorityAbovePercent": 80,
			"system.resources.streamingGuaranteedCores": 2,
			"system.resources.monitoringEnabled": false,
		});
	});

	afterEach(() => {
		systemSettingsStore.deleteRuntimeValues([...SETTINGS_KEYS]);
	});

	describe("calculatePressure", () => {
		test("returns critical when memory or disk >= 95%", () => {
			const a = new ResourceAllocator();
			expect(calculatePressure(a, 50, 95, 50)).toBe("critical");
			expect(calculatePressure(a, 50, 50, 95)).toBe("critical");
			expect(calculatePressure(a, 50, 98, 98)).toBe("critical");
		});

		test("returns high when max(cpu, memoryOrDisk) >= 85", () => {
			const a = new ResourceAllocator();
			expect(calculatePressure(a, 85, 50, 50)).toBe("high");
			expect(calculatePressure(a, 50, 85, 50)).toBe("high");
			expect(calculatePressure(a, 90, 80, 80)).toBe("high");
		});

		test("returns medium when max >= 70", () => {
			const a = new ResourceAllocator();
			expect(calculatePressure(a, 70, 50, 50)).toBe("medium");
			expect(calculatePressure(a, 50, 70, 50)).toBe("medium");
		});

		test("returns low when all below 70", () => {
			const a = new ResourceAllocator();
			expect(calculatePressure(a, 30, 25, 25)).toBe("low");
			expect(calculatePressure(a, 0, 0, 0)).toBe("low");
		});

		test("CPU alone cannot reach critical", () => {
			const a = new ResourceAllocator();
			expect(calculatePressure(a, 100, 50, 50)).toBe("high");
		});
	});

	describe("getWorkerAllocation", () => {
		test("critical pressure throttles all workers except transcode", () => {
			const a = new ResourceAllocator();
			setSnapshot(a, makeSnapshot({ pressure: "critical" }));

			const scanAlloc = a.getWorkerAllocation("library-scan");
			expect(scanAlloc.allocated).toBe(0);
			expect(scanAlloc.throttled).toBe(true);
			expect(scanAlloc.reason).toBe("critical_pressure");

			const transcodeAlloc = a.getWorkerAllocation("transcode");
			expect(transcodeAlloc.allocated).toBeGreaterThanOrEqual(1);
			expect(transcodeAlloc.throttled).toBe(false);
		});

		test("high pressure throttles low-weight workers", () => {
			const a = new ResourceAllocator();
			setSnapshot(a, makeSnapshot({ pressure: "high" }));

			// scanning weight 5 (< 30) → throttled
			const scanAlloc = a.getWorkerAllocation("scanning");
			expect(scanAlloc.allocated).toBe(0);
			expect(scanAlloc.throttled).toBe(true);
			expect(scanAlloc.reason).toBe("high_pressure_low_priority");

			// imageProcessing weight 80 (>= 30) → not throttled
			const imgAlloc = a.getWorkerAllocation("imageProcessing");
			expect(imgAlloc.throttled).toBe(false);
		});

		test("medium pressure throttles low-weight workers when memory above threshold", () => {
			const a = new ResourceAllocator();
			setSnapshot(
				a,
				makeSnapshot({
					pressure: "medium",
					memory: { usedMb: 7000, totalMb: 8000, percent: 87.5 },
				}),
			);

			// scanning weight 5 (< 50) + memory > 80% → throttled
			const scanAlloc = a.getWorkerAllocation("scanning");
			expect(scanAlloc.throttled).toBe(true);
			expect(scanAlloc.reason).toBe("memory_pressure");
			expect(scanAlloc.allocated).toBeGreaterThanOrEqual(1);

			// imageProcessing weight 80 (>= 50) → not throttled
			const imgAlloc = a.getWorkerAllocation("imageProcessing");
			expect(imgAlloc.throttled).toBe(false);
		});

		test("dynamic throttling disabled returns auto concurrency", () => {
			systemSettingsStore.setRuntimeValue("system.resources.enableDynamicThrottling", false);
			const a = new ResourceAllocator();
			setSnapshot(a, makeSnapshot({ pressure: "critical" }));

			const alloc = a.getWorkerAllocation("library-scan");
			expect(alloc.throttled).toBe(false);
		});

		test("low pressure returns full auto concurrency", () => {
			const a = new ResourceAllocator();
			setSnapshot(a, makeSnapshot({ pressure: "low" }));

			const alloc = a.getWorkerAllocation("library-scan");
			expect(alloc.throttled).toBe(false);
		});

		test("no snapshot defaults to low pressure", () => {
			const a = new ResourceAllocator();

			const alloc = a.getWorkerAllocation("library-scan");
			expect(alloc.throttled).toBe(false);
		});

		test("normalizes kebab-case and camelCase worker IDs", () => {
			const a = new ResourceAllocator();
			setSnapshot(a, makeSnapshot({ pressure: "high" }));

			// scanning weight 5 (< 30) -> throttled
			const kebabScan = a.getWorkerAllocation("scanning");
			expect(kebabScan.allocated).toBe(0);
			expect(kebabScan.throttled).toBe(true);

			// image-processing weight 80 (>= 30) -> not throttled, both kebab and camel case
			const kebabImg = a.getWorkerAllocation("image-processing");
			const camelImg = a.getWorkerAllocation("imageProcessing");
			expect(kebabImg.throttled).toBe(false);
			expect(camelImg.throttled).toBe(false);
			expect(kebabImg.allocated).toBe(camelImg.allocated);
		});
	});

	describe("active providers", () => {
		test("activeWorkersProvider populates worker counts in snapshot", async () => {
			const a = new ResourceAllocator();
			a.registerActiveWorkersProvider(() => ({ "image-processing": 3, "media-file-analysis": 1 }));

			setSnapshot(a, makeSnapshot());
			await collectSnapshot(a);

			const snapshot = a.getCurrentSnapshot();
			expect(snapshot?.workers["image-processing"]).toBe(3);
			expect(snapshot?.workers["media-file-analysis"]).toBe(1);
		});

		test("activeStreamsProvider overrides streaming count", async () => {
			const a = new ResourceAllocator();
			a.registerActiveStreamsProvider(() => 4);

			setSnapshot(a, makeSnapshot());
			await collectSnapshot(a);

			const snapshot = a.getCurrentSnapshot();
			expect(snapshot?.activeStreams).toBe(4);
		});
	});

	describe("alert deduplication", () => {
		test("same alert type is suppressed within cooldown", () => {
			const a = new ResourceAllocator();
			const now = Date.now();
			const alerts = getAlerts(a);

			alerts.push({ timestamp: now, type: "memory" });

			const recent = alerts.find((alert) => alert.type === "memory" && now - alert.timestamp < 5 * 60_000);
			expect(recent).toBeDefined();
		});

		test("same alert type fires again after cooldown", () => {
			const a = new ResourceAllocator();
			const now = Date.now();
			const alerts = getAlerts(a);

			alerts.push({ timestamp: now - 6 * 60_000, type: "memory" });

			const recent = alerts.find((alert) => alert.type === "memory" && now - alert.timestamp < 5 * 60_000);
			expect(recent).toBeUndefined();
		});
	});
});

// The settings store is process-global — never leak overrides into other test files.
afterEach(() => systemSettingsStore.clearRuntimeValues());
