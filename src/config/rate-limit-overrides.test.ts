import { afterEach, describe, expect, test } from "bun:test";
import { systemSettingsStore } from "@/config/system-settings.store";
import { rateLimitOverrideIssues, tunedRouteMax } from "./rate-limit-overrides.utils";

// The settings store is process-wide, so every override a test sets is cleared before the next test runs.
afterEach(() => {
	systemSettingsStore.clearRuntimeValues();
});

describe("rateLimitOverrideIssues", () => {
	test("accepts tunable buckets with positive whole numbers", () => {
		expect(rateLimitOverrideIssues("admin-analytics=120, subtitle-content=60")).toEqual({ malformed: [], untunable: [] });
	});

	test("reports malformed entries and buckets that cannot be tuned", () => {
		expect(rateLimitOverrideIssues("auth-login=50,admin-analytics=0,admin-analytics=1.5,admin-analytics")).toEqual({
			malformed: ["admin-analytics=0", "admin-analytics=1.5", "admin-analytics"],
			untunable: ["auth-login"],
		});
	});

	test("an empty setting is valid", () => {
		expect(rateLimitOverrideIssues("")).toEqual({ malformed: [], untunable: [] });
	});
});

describe("tunedRouteMax", () => {
	test("returns the first matching override, capped at ten times the default", () => {
		systemSettingsStore.setRuntimeValue("network.rateLimit.routeOverrides", "admin-analytics=120,admin-analytics=999,subtitle-content=60");

		expect(tunedRouteMax("admin-analytics", 100)).toBe(120);
		expect(tunedRouteMax("subtitle-content", 10)).toBe(60);
		expect(tunedRouteMax("admin-analytics", 10)).toBe(100);
		expect(tunedRouteMax("admin-workers-list", 100)).toBeUndefined();
		expect(tunedRouteMax("auth-login", 10)).toBeUndefined();
	});

	test("picks up a changed override after the settings revision moves", () => {
		systemSettingsStore.setRuntimeValue("network.rateLimit.routeOverrides", "admin-analytics=120");
		expect(tunedRouteMax("admin-analytics", 100)).toBe(120);

		systemSettingsStore.setRuntimeValue("network.rateLimit.routeOverrides", "admin-analytics=500");
		expect(tunedRouteMax("admin-analytics", 100)).toBe(500);
	});

	test("ignores malformed entries and keeps scanning past them", () => {
		systemSettingsStore.setRuntimeValue("network.rateLimit.routeOverrides", "admin-analytics=abc,auth-login=5,admin-analytics=7");

		expect(tunedRouteMax("admin-analytics", 100)).toBe(7);
	});
});
