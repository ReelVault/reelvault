import { describe, expect, test } from "bun:test";
import { clearWrongPins, PIN_ATTEMPT_LIMIT, pinAttemptStatus, recordWrongPin } from "./profile-pin-attempts.limiter";

describe("profile PIN attempts", () => {
	test("counts wrong PINs down to zero and reports the time until the window resets", () => {
		const key = "user-1:profile-attempts-count";
		const start = 1_000_000;

		expect(pinAttemptStatus(key, start)).toEqual({ attemptsRemaining: 10, retryAfterSeconds: 0 });
		for (let attempt = 0; attempt < PIN_ATTEMPT_LIMIT; attempt++) recordWrongPin(key, start);

		expect(pinAttemptStatus(key, start)).toEqual({ attemptsRemaining: 0, retryAfterSeconds: 900 });
		clearWrongPins(key);
	});

	test("starts a fresh budget once the window has passed", () => {
		const key = "user-1:profile-attempts-expiry";
		const start = 2_000_000;
		recordWrongPin(key, start);

		expect(pinAttemptStatus(key, start + 900_000)).toEqual({ attemptsRemaining: 10, retryAfterSeconds: 0 });
		clearWrongPins(key);
	});

	test("a correct PIN clears the failures recorded so far", () => {
		const key = "user-1:profile-attempts-clear";
		recordWrongPin(key, 3_000_000);
		recordWrongPin(key, 3_000_000);
		clearWrongPins(key);

		expect(pinAttemptStatus(key, 3_000_000).attemptsRemaining).toBe(10);
	});
});
