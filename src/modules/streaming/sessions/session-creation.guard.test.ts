import { describe, expect, test } from "bun:test";
import { SessionCreationGuard } from "./session-creation.guard";

describe("session creation guard", () => {
	test("allows the first creation and blocks a burst within the cooldown", () => {
		let now = 1_000;
		const guard = new SessionCreationGuard({ now: () => now });

		expect(() => guard.assertCooldown("profile-1")).not.toThrow();
		now = 1_200;
		expect(() => guard.assertCooldown("profile-1")).toThrow("rate limit exceeded");
	});

	test("allows a new session after the cooldown elapsed and is per profile", () => {
		let now = 1_000;
		const guard = new SessionCreationGuard({ now: () => now });

		guard.assertCooldown("profile-1");
		now = 1_600;
		expect(() => guard.assertCooldown("profile-1")).not.toThrow();

		now = 1_100;
		expect(() => guard.assertCooldown("profile-2")).not.toThrow();
	});

	test("honours a custom cooldown", () => {
		let now = 1_000;
		const guard = new SessionCreationGuard({ cooldownMs: 5_000, now: () => now });

		guard.assertCooldown("profile-1");
		now = 4_000;
		expect(() => guard.assertCooldown("profile-1")).toThrow("rate limit exceeded");
		now = 6_000;
		expect(() => guard.assertCooldown("profile-1")).not.toThrow();
	});

	test("forgets profiles one minute after their last creation", () => {
		let now = 1_000;
		const guard = new SessionCreationGuard({ now: () => now });

		guard.assertCooldown("profile-1");
		guard.assertCooldown("profile-2");
		now = 61_001;
		guard.assertCooldown("profile-3");

		expect(() => guard.assertCooldown("profile-1")).not.toThrow();
		expect(() => guard.assertCooldown("profile-2")).not.toThrow();
	});
});
