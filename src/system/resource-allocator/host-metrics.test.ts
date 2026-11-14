import { describe, expect, test } from "bun:test";
import { cgroupCpuPercent, memoryReading, resolveAvailableMemoryKiB } from "./host-metrics.reader";

describe("memoryReading", () => {
	test("keeps used memory between zero and the total, and reports zero percent for a zero total", () => {
		expect(memoryReading(2048, -100)).toEqual({ usedMb: 0, totalMb: 2048, percent: 0 });
		expect(memoryReading(2048, 4096)).toEqual({ usedMb: 2048, totalMb: 2048, percent: 100 });
		expect(memoryReading(0, 10)).toEqual({ usedMb: 0, totalMb: 0, percent: 0 });
	});
});

describe("resolveAvailableMemoryKiB", () => {
	test("counts the reclaimable ZFS ARC as available", () => {
		const total = 8 * 1024 * 1024;
		// 1 GB MemAvailable + 4 GB reclaimable ARC on an 8 GB host.
		expect(resolveAvailableMemoryKiB(total, 1 * 1024 * 1024, 4 * 1024 * 1024)).toBe(5 * 1024 * 1024);
	});

	test("caps available memory at the installed total", () => {
		expect(resolveAvailableMemoryKiB(8 * 1024 * 1024, 6 * 1024 * 1024, 20 * 1024 * 1024)).toBe(8 * 1024 * 1024);
	});

	test("leaves a host without a ZFS ARC unchanged", () => {
		expect(resolveAvailableMemoryKiB(8 * 1024 * 1024, 6 * 1024 * 1024, 0)).toBe(6 * 1024 * 1024);
	});
});

describe("cgroupCpuPercent", () => {
	test("reports container CPU from the second reading, scaled by the cores the container may use", () => {
		// The first reading only sets the baseline (its result depends on earlier calls in this process).
		cgroupCpuPercent(1_000_000, 10_000, 2);

		// One core-second of CPU in one second, on a container allowed two cores: 50%.
		expect(cgroupCpuPercent(2_000_000, 11_000, 2)).toBe(50);
	});
});
