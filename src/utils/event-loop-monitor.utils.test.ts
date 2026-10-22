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

	test("each read reports only the window since the previous read", async () => {
		const monitor = new EventLoopMonitor(20);
		try {
			monitor.read();
			Bun.sleepSync(300); // one long stall inside the first window
			await Bun.sleep(25); // let the probe timer observe the stall
			expect(monitor.read()).toBeGreaterThan(0.5);

			await Bun.sleep(300); // a calm window
			expect(monitor.read()).toBeLessThan(0.25);
		} finally {
			monitor.stop();
		}
	});
});
