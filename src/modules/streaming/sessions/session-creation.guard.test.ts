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

	test("blocks a second default-cooldown creation until 500 ms have passed", () => {
		let now = 10_000;
		const guard = new SessionCreationGuard({ now: () => now });

		guard.assertCooldown("profile-default");
		now = 10_499;
		expect(() => guard.assertCooldown("profile-default")).toThrow(
			expect.objectContaining({
				code: "stream.creation_throttled",
				params: expect.objectContaining({ retryAfterSeconds: 1 }),
			}),
		);
		now = 10_500;
		guard.assertCooldown("profile-default");
	});

	test("keeps independent cooldowns for two profiles", () => {
		let now = 20_000;
		const guard = new SessionCreationGuard({ now: () => now });
		guard.assertCooldown("profile-a");
		guard.assertCooldown("profile-b");
		now = 20_100;

		expect(() => guard.assertCooldown("profile-a")).toThrow(expect.objectContaining({ code: "stream.creation_throttled" }));
		expect(() => guard.assertCooldown("profile-b")).toThrow(expect.objectContaining({ code: "stream.creation_throttled" }));
	});

	test("rounds a partial remaining second up in the retry hint", () => {
		let now = 1_000;
		const guard = new SessionCreationGuard({ cooldownMs: 5_000, now: () => now });
		guard.assertCooldown("profile-1");
		now = 4_999;

		expect(() => guard.assertCooldown("profile-1")).toThrow(
			expect.objectContaining({
				code: "stream.creation_throttled",
				params: expect.objectContaining({ retryAfterSeconds: 2 }),
			}),
		);
	});
});
