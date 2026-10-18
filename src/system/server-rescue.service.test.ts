import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MINUTE } from "@/config/server/server.constants";
import { systemSettingsStore } from "@/config/system-settings.store";
import { ServerRescueService } from "./server-rescue.service";

/** The worst event-loop lag the next check sees. */
let sampledLagMs = 0;

function setLag(lagMs: number): void {
	sampledLagMs = lagMs;
}

function newService(): ServerRescueService {
	return new ServerRescueService(() => sampledLagMs);
}

/**
 * `runCheck` is the rescue timer's callback (init arms it with setInterval) and has no
 * public entry point, so tests drive the state machine through it with an explicit `now`.
 */
function check(service: ServerRescueService, now: number): void {
	Reflect.apply(Reflect.get(service, "runCheck"), service, [now]);
}

function engageAt(service: ServerRescueService, breachStart: number): void {
	setLag(300);
	check(service, breachStart);
	setLag(300);
	check(service, breachStart + 15_000); // sustained → engage
	expect(service.isThrottling()).toBe(true);
}

function releaseAt(service: ServerRescueService, healthyStart: number): void {
	setLag(0);
	check(service, healthyStart);
	setLag(0);
	check(service, healthyStart + 60_000); // releaseMs of health → release
	expect(service.isThrottling()).toBe(false);
}

function useRescueSettings(): void {
	// Pin the defaults so unrelated test files leaving overrides in the shared
	// runtime store cannot skew the state machine timings.
	beforeEach(() => {
		sampledLagMs = 0;
		systemSettingsStore.setRuntimeValues({
			"system.rescue.enabled": true,
			"system.rescue.eventLoopLagMs": 250,
			"system.rescue.sustainMs": 15000,
			"system.rescue.releaseMs": 60000,
		});
	});

	afterEach(() => {
		systemSettingsStore.deleteRuntimeValues([
			"system.rescue.enabled",
			"system.rescue.eventLoopLagMs",
			"system.rescue.sustainMs",
			"system.rescue.releaseMs",
		]);
	});
}

describe("ServerRescueService engagement", () => {
	useRescueSettings();

	test("stays healthy while lag and pressure are below thresholds", () => {
		const service = newService();
		service.registerPressureProvider(() => "low");

		setLag(100);
		check(service, 0);
		check(service, 20_000);

		expect(service.isThrottling()).toBe(false);
		expect(service.getRescueAllocation("library-scan")).toBeUndefined();
	});

	test("engages rescue after sustained event-loop lag and pauses non-protected workers", () => {
		const service = newService();
		service.registerPressureProvider(() => "low");
		let cancelCalls = 0;
		service.registerActions({ cancelBackgroundTasks: () => cancelCalls++ });

		// Every checked window needs a fresh lag sample, since a check consumes it
		setLag(300); // above 250ms default threshold
		check(service, 1_000); // breach recorded
		setLag(300);
		check(service, 15_999); // 14.9s < sustainMs 15s — still healthy
		expect(service.isThrottling()).toBe(false);

		setLag(300);
		check(service, 16_000); // sustained for 15s → rescue
		expect(service.isThrottling()).toBe(true);
		expect(service.getRescueAllocation("library-scan")).toEqual({ allocated: 0, throttled: true, reason: "server_rescue" });
		expect(service.getRescueAllocation("imageProcessing")).toEqual({ allocated: 0, throttled: true, reason: "server_rescue" });
		// Playback workers are exempt
		expect(service.getRescueAllocation("stream-init")).toBeUndefined();
		expect(service.isWorkerProtected("stream-init")).toBe(true);
		// Entering rescue escalates immediately
		expect(cancelCalls).toBe(1);
	});

	test("escalation has a cooldown while already rescuing", () => {
		const service = newService();
		service.registerPressureProvider(() => "low");
		let cancelCalls = 0;
		service.registerActions({ cancelBackgroundTasks: () => cancelCalls++ });

		setLag(300);
		check(service, 0);
		setLag(300);
		check(service, 15_000); // rescue engaged, escalation #1

		setLag(300);
		check(service, 20_000); // inside ESCALATION_COOLDOWN_MS
		expect(cancelCalls).toBe(1);

		setLag(300);
		check(service, 45_001); // cooldown elapsed
		expect(cancelCalls).toBe(2);
	});
});

describe("ServerRescueService release", () => {
	useRescueSettings();

	test("releases rescue after the system stays healthy for releaseMs", () => {
		const service = newService();
		service.registerPressureProvider(() => "low");

		setLag(300);
		check(service, 0);
		setLag(300);
		check(service, 15_000);
		expect(service.isThrottling()).toBe(true);

		setLag(0);
		check(service, 20_000); // healthy period starts
		setLag(0);
		check(service, 79_999); // 59.9s < releaseMs 60s
		expect(service.isThrottling()).toBe(true);

		setLag(0);
		check(service, 80_000);
		expect(service.isThrottling()).toBe(false);
		expect(service.getRescueAllocation("library-scan")).toBeUndefined();
	});

	test("critical system pressure alone engages rescue", () => {
		const service = newService();
		service.registerPressureProvider(() => "critical");

		setLag(0);
		check(service, 0);
		check(service, 15_000);

		expect(service.isThrottling()).toBe(true);
		expect(service.getState().reason).toContain("critical");
	});

	test("disabling the setting mid-rescue releases immediately", () => {
		const service = newService();
		service.registerPressureProvider(() => "critical");

		setLag(0);
		check(service, 0);
		check(service, 15_000);
		expect(service.isThrottling()).toBe(true);

		systemSettingsStore.setRuntimeValue("system.rescue.enabled", false);
		try {
			setLag(0);
			check(service, 16_000);
			expect(service.isThrottling()).toBe(false);
		} finally {
			systemSettingsStore.deleteRuntimeValues(["system.rescue.enabled"]);
		}
	});
});

describe("ServerRescueService thresholds", () => {
	useRescueSettings();

	test("slow cores scale the lag threshold and sustain window up before engaging", () => {
		const service = newService();
		service.registerPressureProvider(() => "low");
		// speedFactor 0.35 → scale 1.65: threshold 250→412.5ms, sustain 15s→24.75s
		service.registerSpeedFactorProvider(() => 0.35);

		// 300ms breaches the 250ms base threshold but not the scaled one
		setLag(300);
		check(service, 1_000);
		setLag(300);
		check(service, 60_000);
		expect(service.isThrottling()).toBe(false);

		setLag(500); // above the 412.5ms scaled threshold
		check(service, 61_000);
		setLag(500);
		check(service, 85_000); // 24s of breach < 24.75s scaled sustain
		expect(service.isThrottling()).toBe(false);

		setLag(500);
		check(service, 86_000); // sustained for 25s → rescue
		expect(service.isThrottling()).toBe(true);
	});

	test("repeated flaps raise the lag threshold so background work gets longer windows", () => {
		const service = newService();
		service.registerPressureProvider(() => "low");

		engageAt(service, 0); // engage #1 at 15_000
		releaseAt(service, 15_001);
		engageAt(service, 75_002); // engage #2 at 90_002
		releaseAt(service, 90_003);
		engageAt(service, 150_004); // engage #3 — three engages inside the 15 min flap window
		releaseAt(service, 165_005);

		// 4th breach of 300ms: recentEngages = 3 → threshold ×1.5 → 375ms → no breach
		setLag(300);
		check(service, 225_006);
		setLag(300);
		check(service, 260_000);
		expect(service.isThrottling()).toBe(false);

		// …but crossing the escalated threshold still engages
		setLag(400);
		check(service, 260_001);
		setLag(400);
		check(service, 285_000);
		expect(service.isThrottling()).toBe(true);
		expect(service.getState().escalations).toBe(4);
	});

	test("a calm spell longer than the flap window restores the configured lag threshold", () => {
		const service = newService();
		service.registerPressureProvider(() => "low");
		engageAt(service, 0);
		releaseAt(service, 15_001);
		engageAt(service, 75_002);
		releaseAt(service, 90_003);
		engageAt(service, 150_004);
		releaseAt(service, 165_005);

		// Engages older than the 15 min flap window stop raising the threshold: 300ms is a plain breach of 250ms, not 375ms
		const calmStart = 165_005 + 15 * MINUTE + 1_000;
		setLag(300);
		check(service, calmStart);
		setLag(300);
		check(service, calmStart + 15_000);
		expect(service.isThrottling()).toBe(true);
	});
});

// The settings store is process-global — never leak overrides into other test files.
afterEach(() => systemSettingsStore.clearRuntimeValues());
