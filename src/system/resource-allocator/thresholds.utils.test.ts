import { describe, expect, test } from "bun:test";
import type { ResourceSnapshot } from "./resource-allocator.types";
import { calculatePressure, thresholdAlerts } from "./thresholds.utils";

// Defaults from config/definitions/resources.definitions.ts: memory warning 85, memory critical 95, disk warning 90.
function snapshot(usage: { memory?: number; disk?: number }): ResourceSnapshot {
	return {
		timestamp: 0,
		cpu: { usedPercent: 0, loadAvg: [0, 0, 0] },
		memory: { usedMb: 0, totalMb: 0, percent: usage.memory ?? 0 },
		disk: { usedGb: 0, totalGb: 0, percent: usage.disk ?? 0 },
		pressure: "low",
		activeStreams: 0,
		workers: {},
	};
}

describe("thresholdAlerts", () => {
	test("raises a critical disk alert at the critical band, not only a warning", () => {
		expect(thresholdAlerts(snapshot({ disk: 96 }))).toEqual([
			{ severity: "critical", type: "disk", code: "system.disk_low", params: { percent: 96 } },
		]);
	});

	test("raises a warning disk alert between the disk threshold and the critical band", () => {
		expect(thresholdAlerts(snapshot({ disk: 92 }))).toEqual([
			{ severity: "warning", type: "disk", code: "system.disk_low", params: { percent: 92 } },
		]);
	});

	test("raises no alert while memory and disk stay below their thresholds", () => {
		expect(thresholdAlerts(snapshot({ memory: 40, disk: 50 }))).toEqual([]);
	});

	test("reports critical disk exactly as calculatePressure does", () => {
		expect(calculatePressure(10, 10, 96)).toBe("critical");
	});
});
