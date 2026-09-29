import { describe, expect, test } from "bun:test";
import { EventLoopMonitor } from "./event-loop-monitor.utils";

describe("EventLoopMonitor", () => {
	test("returns undefined on the first read (no window yet)", () => {
		const monitor = new EventLoopMonitor(20);
		try {
			expect(monitor.read()).toBeUndefined();
		} finally {
			monitor.stop();
		}
	});

	test("reports utilization in [0, 1] after a measurement window", async () => {
		const monitor = new EventLoopMonitor(20);
		try {
			monitor.read();
			await Bun.sleep(120);
			const utilization = monitor.read();

			expect(typeof utilization).toBe("number");
			expect(Number.isFinite(utilization)).toBe(true);
			expect(utilization).toBeGreaterThanOrEqual(0);
			expect(utilization).toBeLessThanOrEqual(1);
		} finally {
			monitor.stop();
		}
	});

	test("resets the window on read — consecutive reads measure fresh windows", async () => {
		const monitor = new EventLoopMonitor(20);
		try {
			monitor.read();
			await Bun.sleep(100);
			expect(Number.isFinite(monitor.read())).toBe(true);
			await Bun.sleep(100);
			expect(Number.isFinite(monitor.read())).toBe(true);
		} finally {
			monitor.stop();
		}
	});
});
