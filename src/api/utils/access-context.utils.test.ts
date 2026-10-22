import { describe, expect, test } from "bun:test";
import { requireProfileId } from "./access-context.utils";

describe("requireProfileId", () => {
	test("returns the active profile id", () => {
		expect(requireProfileId({ id: "profile-1" })).toBe("profile-1");
	});

	// The refusal itself is owned by src/utils/errors.test.ts, where assertProfileId
	// lives. Here only the wiring around it is at stake.
	test("refuses a missing profile with the profile-required code", () => {
		expect(() => requireProfileId(null)).toThrow(expect.objectContaining({ category: "unauthorized", code: "auth.profile_required" }));
		expect(() => requireProfileId(undefined)).toThrow(expect.objectContaining({ category: "unauthorized", code: "auth.profile_required" }));
	});
});
