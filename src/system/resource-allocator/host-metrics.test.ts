import { describe, expect, test } from "bun:test";
import { cgroupCpuPercent } from "./host-metrics.reader";

describe("cgroupCpuPercent", () => {
	test("reports container CPU from the second reading, scaled by the cores the container may use", () => {
		// The first reading only sets the baseline (its result depends on earlier calls in this process).
		cgroupCpuPercent(1_000_000, 10_000, 2);

		// One core-second of CPU in one second, on a container allowed two cores: 50%.
		expect(cgroupCpuPercent(2_000_000, 11_000, 2)).toBe(50);
	});
});
