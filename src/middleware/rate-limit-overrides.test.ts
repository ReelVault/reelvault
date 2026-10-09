import { describe, expect, test } from "bun:test";
import { RATE_LIMIT_OVERRIDE_CAP_MULTIPLIER, rateLimitOverrideIssues } from "./rate-limit-overrides";

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

	test("the cap is a fixed multiple of the route default", () => {
		expect(RATE_LIMIT_OVERRIDE_CAP_MULTIPLIER).toBe(10);
	});
});
