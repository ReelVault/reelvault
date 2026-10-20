import { describe, expect, test } from "bun:test";
import { cgroupCpuPercent, memoryReading } from "./host-metrics.reader";

describe("memoryReading", () => {
	test("clamps a constrained total so the dashboard cannot receive a negative or over-100 value", () => {
		expect(memoryReading(2048, -100)).toEqual({ usedMb: 0, totalMb: 2048, percent: 0 });
		expect(memoryReading(2048, 4096)).toEqual({ usedMb: 2048, totalMb: 2048, percent: 100 });
		expect(memoryReading(0, 10)).toEqual({ usedMb: 0, totalMb: 0, percent: 0 });
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
