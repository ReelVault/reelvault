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
});
