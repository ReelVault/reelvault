import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { systemSettingsStore } from "@/config/system-settings.store";
import { ServerRescueService } from "./server-rescue.service";

const setLag = (service: ServerRescueService, lagMs: number): void => {
	Reflect.set(service, "maxLagSinceCheck", lagMs);
};

const check = (service: ServerRescueService, now: number): void => {
	const runCheck = Reflect.get(service, "runCheck");
	if (typeof runCheck === "function") {
		Reflect.apply(runCheck, service, [now]);
	}
};

describe("ServerRescueService", () => {
	// Pin the defaults so unrelated test files leaving overrides in the shared
	// runtime store cannot skew the state machine timings.
	beforeEach(() => {
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

	test("stays healthy while lag and pressure are below thresholds", () => {
		const service = new ServerRescueService();
		service.registerPressureProvider(() => "low");

		setLag(service, 100);
		check(service, 0);
		check(service, 20_000);

		expect(service.isThrottling()).toBe(false);
		expect(service.getRescueAllocation("library-scan")).toBeUndefined();
	});

	test("engages rescue after sustained event-loop lag and pauses non-protected workers", () => {
		const service = new ServerRescueService();
		service.registerPressureProvider(() => "low");
		let cancelCalls = 0;
		service.registerActions({ cancelBackgroundTasks: () => cancelCalls++ });

		// runCheck consumes the window's max lag, so every checked window needs a sample
		setLag(service, 300); // above 250ms default threshold
		check(service, 1_000); // breach recorded
		setLag(service, 300);
		check(service, 15_999); // 14.9s < sustainMs 15s — still healthy
		expect(service.isThrottling()).toBe(false);

		setLag(service, 300);
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
		const service = new ServerRescueService();
		service.registerPressureProvider(() => "low");
		let cancelCalls = 0;
		service.registerActions({ cancelBackgroundTasks: () => cancelCalls++ });

		setLag(service, 300);
		check(service, 0);
		setLag(service, 300);
		check(service, 15_000); // rescue engaged, escalation #1

		setLag(service, 300);
		check(service, 20_000); // inside ESCALATION_COOLDOWN_MS
		expect(cancelCalls).toBe(1);

		setLag(service, 300);
		check(service, 45_001); // cooldown elapsed
		expect(cancelCalls).toBe(2);
	});

	test("releases rescue after the system stays healthy for releaseMs", () => {
		const service = new ServerRescueService();
		service.registerPressureProvider(() => "low");

		setLag(service, 300);
		check(service, 0);
		setLag(service, 300);
		check(service, 15_000);
		expect(service.isThrottling()).toBe(true);

		setLag(service, 0);
		check(service, 20_000); // healthy period starts
		setLag(service, 0);
		check(service, 79_999); // 59.9s < releaseMs 60s
		expect(service.isThrottling()).toBe(true);

		setLag(service, 0);
		check(service, 80_000);
		expect(service.isThrottling()).toBe(false);
		expect(service.getRescueAllocation("library-scan")).toBeUndefined();
	});

	test("critical system pressure alone engages rescue", () => {
		const service = new ServerRescueService();
		service.registerPressureProvider(() => "critical");

		setLag(service, 0);
		check(service, 0);
		check(service, 15_000);

		expect(service.isThrottling()).toBe(true);
		expect(service.getState().reason).toContain("critical");
	});

	test("disabling the setting mid-rescue releases immediately", () => {
		const service = new ServerRescueService();
		service.registerPressureProvider(() => "critical");

		setLag(service, 0);
		check(service, 0);
		check(service, 15_000);
		expect(service.isThrottling()).toBe(true);

		systemSettingsStore.setRuntimeValue("system.rescue.enabled", false);
		try {
			setLag(service, 0);
			check(service, 16_000);
			expect(service.isThrottling()).toBe(false);
		} finally {
			systemSettingsStore.deleteRuntimeValues(["system.rescue.enabled"]);
		}
	});

	test("slow cores scale the lag threshold and sustain window up before engaging", () => {
		const service = new ServerRescueService();
		service.registerPressureProvider(() => "low");
		// speedFactor 0.35 → scale 1.65: threshold 250→412.5ms, sustain 15s→24.75s
		service.registerSpeedFactorProvider(() => 0.35);

		// 300ms breaches the 250ms base threshold but not the scaled one
		setLag(service, 300);
		check(service, 1_000);
		setLag(service, 300);
		check(service, 60_000);
		expect(service.isThrottling()).toBe(false);

		setLag(service, 500); // above the 412.5ms scaled threshold
		check(service, 61_000);
		setLag(service, 500);
		check(service, 85_000); // 24s of breach < 24.75s scaled sustain
		expect(service.isThrottling()).toBe(false);

		setLag(service, 500);
		check(service, 86_000); // sustained for 25s → rescue
		expect(service.isThrottling()).toBe(true);
	});

	test("repeated flaps raise the lag threshold so background work gets longer windows", () => {
		const service = new ServerRescueService();
		service.registerPressureProvider(() => "low");

		const engageAt = (breachStart: number) => {
			setLag(service, 300);
			check(service, breachStart);
			setLag(service, 300);
			check(service, breachStart + 15_000); // sustained → engage
			expect(service.isThrottling()).toBe(true);
		};
		const releaseAt = (healthyStart: number) => {
			setLag(service, 0);
			check(service, healthyStart);
			setLag(service, 0);
			check(service, healthyStart + 60_000); // releaseMs of health → release
			expect(service.isThrottling()).toBe(false);
		};

		engageAt(0); // engage #1 at 15_000
		releaseAt(15_001);
		engageAt(75_002); // engage #2 at 90_002
		releaseAt(90_003);
		engageAt(150_004); // engage #3 — three engages inside the 15 min flap window
		releaseAt(165_005);

		// 4th breach of 300ms: recentEngages = 3 → threshold ×1.5 → 375ms → no breach
		setLag(service, 300);
		check(service, 225_006);
		setLag(service, 300);
		check(service, 260_000);
		expect(service.isThrottling()).toBe(false);

		// …but crossing the escalated threshold still engages
		setLag(service, 400);
		check(service, 260_001);
		setLag(service, 400);
		check(service, 285_000);
		expect(service.isThrottling()).toBe(true);
		expect(service.getState().escalations).toBe(4);
	});

	test("flap memory ages out after an hour of calm", () => {
		const service = new ServerRescueService();
		service.registerPressureProvider(() => "low");

		// Manually seed engage history as if the service flapped recently
		Reflect.set(service, "engageTimes", [900_000 - (60 * 60_000 + 1)]);
		setLag(service, 300);
		check(service, 900_000); // > FLAP_MEMORY_MS after the last engage → multiplier reset to 1
		setLag(service, 300);
		check(service, 915_000);
		expect(service.isThrottling()).toBe(true);
	});
});

// The settings store is process-global — never leak overrides into other test files.
afterEach(() => systemSettingsStore.clearRuntimeValues());
