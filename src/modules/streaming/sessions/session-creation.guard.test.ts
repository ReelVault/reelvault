import { describe, expect, test } from "bun:test";
import { SessionCreationGuard } from "./session-creation.guard";

describe("session creation guard", () => {
	test("allows the first creation and blocks a burst within the cooldown", () => {
		let now = 1_000;
		const guard = new SessionCreationGuard({ cooldownMs: 500, now: () => now });

		guard.assertCooldown("profile-1");
		now = 1_200;
		expect(() => guard.assertCooldown("profile-1")).toThrow(
			expect.objectContaining({ category: "too_many_requests", code: "stream.creation_throttled" }),
		);
	});

	test("restarts the cooldown from each allowed creation", () => {
		let now = 1_000;
		const guard = new SessionCreationGuard({ cooldownMs: 500, now: () => now });

		guard.assertCooldown("profile-1");
		now = 1_600;
		guard.assertCooldown("profile-1");

		now = 1_700;
		expect(() => guard.assertCooldown("profile-1")).toThrow(
			expect.objectContaining({ category: "too_many_requests", code: "stream.creation_throttled" }),
		);
	});

	test("honours a custom cooldown", () => {
		let now = 1_000;
		const guard = new SessionCreationGuard({ cooldownMs: 5_000, now: () => now });

		guard.assertCooldown("profile-1");
		now = 4_000;
		expect(() => guard.assertCooldown("profile-1")).toThrow(
			expect.objectContaining({ category: "too_many_requests", code: "stream.creation_throttled" }),
		);
		now = 6_000;
		guard.assertCooldown("profile-1");
	});

	test("a rejected burst carries a stable code and a retry hint in whole seconds", () => {
		const now = 1_000;
		const guard = new SessionCreationGuard({ cooldownMs: 5_000, now: () => now });
		guard.assertCooldown("profile-1");

		expect(() => guard.assertCooldown("profile-1")).toThrow(
			expect.objectContaining({
				code: "stream.creation_throttled",
				params: expect.objectContaining({ retryAfterSeconds: 5 }),
			}),
		);
	});
});
