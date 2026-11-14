import { describe, expect, test } from "bun:test";
import { watchdogIntervalMs } from "./systemd-watchdog.service";

describe("watchdogIntervalMs", () => {
	test("sends the heartbeat at half the configured window", () => {
		expect(watchdogIntervalMs(60_000_000)).toBe(30_000);
	});

	test("caps a long window at the maximum interval", () => {
		expect(watchdogIntervalMs(300_000_000)).toBe(30_000);
	});

	test("keeps a short window from spinning", () => {
		expect(watchdogIntervalMs(2_000_000)).toBe(1_000);
	});

	test("stays off when WatchdogSec is absent", () => {
		expect(watchdogIntervalMs(0)).toBe(0);
		expect(watchdogIntervalMs(Number.NaN)).toBe(0);
	});
});
