import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { systemSettingsStore } from "@/config/system-settings.store";
import { ResourceAllocator } from "./resource-allocator.service";

const SETTINGS_KEYS = [
	"system.resources.enableDynamicThrottling",
	"system.resources.throttleLowPriorityAbovePercent",
	"system.resources.streamingGuaranteedCores",
	"system.resources.monitoringEnabled",
] as const;

const allocators: ResourceAllocator[] = [];

/** Host readings with the given CPU, memory and disk percentages. */
function metricsAt(cpuUsedPercent: number, memoryPercent: number, diskPercent: number) {
	return {
		cpuUsedPercent,
		memory: { usedMb: Math.round((memoryPercent / 100) * 8000), totalMb: 8000, percent: memoryPercent },
		disk: { usedGb: Math.round((diskPercent / 100) * 200), totalGb: 200, percent: diskPercent },
	};
}

function allocatorWith(metrics: ReturnType<typeof metricsAt>): ResourceAllocator {
	const allocator = new ResourceAllocator(async () => metrics);
	allocators.push(allocator);

	return allocator;
}

/** Turns monitoring on and takes the first snapshot. The monitor interval is disarmed in afterEach. */
async function takeSnapshot(allocator: ResourceAllocator): Promise<void> {
	systemSettingsStore.setRuntimeValue("system.resources.monitoringEnabled", true);
	await allocator.initialize();
}

function useAllocatorFixture(): void {
	beforeEach(() => {
		systemSettingsStore.setRuntimeValues({
			"system.resources.enableDynamicThrottling": true,
			"system.resources.throttleLowPriorityAbovePercent": 80,
			"system.resources.streamingGuaranteedCores": 2,
			"system.resources.monitoringEnabled": false,
		});
	});

	afterEach(async () => {
		for (const allocator of allocators.splice(0)) await allocator.shutdown();
		systemSettingsStore.deleteRuntimeValues([...SETTINGS_KEYS]);
	});
}

describe("ResourceAllocator pressure", () => {
	useAllocatorFixture();

	test.each([
		{ cpu: 50, memory: 95, disk: 50, pressure: "critical" },
		{ cpu: 50, memory: 50, disk: 95, pressure: "critical" },
		{ cpu: 50, memory: 98, disk: 98, pressure: "critical" },
		{ cpu: 85, memory: 50, disk: 50, pressure: "high" },
		{ cpu: 50, memory: 85, disk: 50, pressure: "high" },
		{ cpu: 90, memory: 80, disk: 80, pressure: "high" },
		{ cpu: 70, memory: 50, disk: 50, pressure: "medium" },
		{ cpu: 50, memory: 70, disk: 50, pressure: "medium" },
		{ cpu: 30, memory: 25, disk: 25, pressure: "low" },
		{ cpu: 0, memory: 0, disk: 0, pressure: "low" },
	])("cpu $cpu%, memory $memory%, disk $disk% is $pressure pressure", async ({ cpu, memory, disk, pressure }) => {
		const allocator = allocatorWith(metricsAt(cpu, memory, disk));
		await takeSnapshot(allocator);

		expect(allocator.getCurrentSnapshot()?.pressure).toBe(pressure);
	});

	test("CPU alone cannot reach critical pressure", async () => {
		const allocator = allocatorWith(metricsAt(100, 50, 50));
		await takeSnapshot(allocator);

		expect(allocator.getCurrentSnapshot()?.pressure).toBe("high");
	});
});

describe("ResourceAllocator worker allocation", () => {
	useAllocatorFixture();

	test("critical pressure throttles all workers except transcode", async () => {
		const allocator = allocatorWith(metricsAt(50, 96, 50));
		await takeSnapshot(allocator);

		const scanAlloc = allocator.getWorkerAllocation("library-scan");
		expect(scanAlloc.allocated).toBe(0);
		expect(scanAlloc.throttled).toBe(true);
		expect(scanAlloc.reason).toBe("critical_pressure");

		const transcodeAlloc = allocator.getWorkerAllocation("transcode");
		expect(transcodeAlloc.allocated).toBeGreaterThanOrEqual(1);
		expect(transcodeAlloc.throttled).toBe(false);
	});

	test("high pressure throttles low-weight workers", async () => {
		const allocator = allocatorWith(metricsAt(90, 50, 50));
		await takeSnapshot(allocator);

		// scanning weight 5 (< 30) → throttled
		const scanAlloc = allocator.getWorkerAllocation("scanning");
		expect(scanAlloc.allocated).toBe(0);
		expect(scanAlloc.throttled).toBe(true);
		expect(scanAlloc.reason).toBe("high_pressure_low_priority");

		// imageProcessing weight 80 (>= 30) → not throttled
		const imgAlloc = allocator.getWorkerAllocation("imageProcessing");
		expect(imgAlloc.throttled).toBe(false);
	});

	test("medium pressure throttles low-weight workers when memory above threshold", async () => {
		// Medium pressure with memory above the 80% throttle threshold (82% stays under the 85% high-pressure line)
		const allocator = allocatorWith(metricsAt(30, 82, 25));
		await takeSnapshot(allocator);

		// scanning weight 5 (< 50) + memory > 80% → throttled
		const scanAlloc = allocator.getWorkerAllocation("scanning");
		expect(scanAlloc.throttled).toBe(true);
		expect(scanAlloc.reason).toBe("memory_pressure");
		expect(scanAlloc.allocated).toBeGreaterThanOrEqual(1);

		// imageProcessing weight 80 (>= 50) → not throttled
		const imgAlloc = allocator.getWorkerAllocation("imageProcessing");
		expect(imgAlloc.throttled).toBe(false);
	});

	test("dynamic throttling disabled never throttles under critical pressure", async () => {
		systemSettingsStore.setRuntimeValue("system.resources.enableDynamicThrottling", false);
		const allocator = allocatorWith(metricsAt(50, 96, 50));
		await takeSnapshot(allocator);

		const alloc = allocator.getWorkerAllocation("library-scan");
		expect(alloc.throttled).toBe(false);
	});

	test("low pressure leaves library-scan unthrottled", async () => {
		const allocator = allocatorWith(metricsAt(30, 25, 25));
		await takeSnapshot(allocator);

		const alloc = allocator.getWorkerAllocation("library-scan");
		expect(alloc.throttled).toBe(false);
	});

	test("does not throttle a worker before the first snapshot", () => {
		const allocator = allocatorWith(metricsAt(50, 96, 50));

		const alloc = allocator.getWorkerAllocation("library-scan");
		expect(alloc.throttled).toBe(false);
	});

	test("normalizes kebab-case and camelCase worker IDs", async () => {
		const allocator = allocatorWith(metricsAt(90, 50, 50));
		await takeSnapshot(allocator);

		// scanning weight 5 (< 30) -> throttled
		const kebabScan = allocator.getWorkerAllocation("scanning");
		expect(kebabScan.allocated).toBe(0);
		expect(kebabScan.throttled).toBe(true);

		// image-processing weight 80 (>= 30) -> not throttled, both kebab and camel case
		const kebabImg = allocator.getWorkerAllocation("image-processing");
		const camelImg = allocator.getWorkerAllocation("imageProcessing");
		expect(kebabImg.throttled).toBe(false);
		expect(camelImg.throttled).toBe(false);
		expect(kebabImg.allocated).toBe(camelImg.allocated);
	});
});

describe("ResourceAllocator active providers", () => {
	useAllocatorFixture();

	test("activeWorkersProvider populates worker counts in snapshot", async () => {
		const allocator = allocatorWith(metricsAt(30, 25, 25));
		allocator.registerActiveWorkersProvider(() => ({ "image-processing": 3, "media-file-analysis": 1 }));
		await takeSnapshot(allocator);

		const snapshot = allocator.getCurrentSnapshot();
		expect(snapshot?.workers["image-processing"]).toBe(3);
		expect(snapshot?.workers["media-file-analysis"]).toBe(1);
	});

	test("activeStreamsProvider overrides streaming count", async () => {
		const allocator = allocatorWith(metricsAt(30, 25, 25));
		allocator.registerActiveStreamsProvider(() => 4);
		await takeSnapshot(allocator);

		expect(allocator.getCurrentSnapshot()?.activeStreams).toBe(4);
	});
});

// The settings store is process-global — never leak overrides into other test files.
afterEach(() => systemSettingsStore.clearRuntimeValues());
