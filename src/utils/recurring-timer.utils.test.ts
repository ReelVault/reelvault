import { describe, expect, test } from "bun:test";
import { RecurringTimer } from "./recurring-timer.utils";

describe("RecurringTimer", () => {
	test("starts on start(), ignores a second start, and stops ticking after stop()", async () => {
		let calls = 0;
		const timer = new RecurringTimer(() => {
			calls++;
		}, 5);

		expect(timer.running).toBeFalse();
		timer.start();
		timer.start();
		expect(timer.running).toBeTrue();

		await Bun.sleep(40);
		timer.stop();
		const callsAtStop = calls;

		await Bun.sleep(30);
		expect(callsAtStop).toBeGreaterThan(0);
		expect(calls).toBe(callsAtStop);
		expect(timer.running).toBeFalse();
	});

	test("routes an async callback failure to onError and keeps ticking", async () => {
		const failure = new Error("async failure");
		const errors: unknown[] = [];
		let calls = 0;
		const routed = Promise.withResolvers<void>();
		const timer = new RecurringTimer(
			() => {
				calls++;
				// The timer only stops on its second tick: reaching it proves the
				// first failure did not stop the interval.
				if (calls === 2) timer.stop();

				return Promise.reject(failure);
			},
			5,
			(error) => {
				errors.push(error);
				if (errors.length === 2) routed.resolve();
			},
		);

		timer.start();
		await routed.promise;

		expect(calls).toBe(2);
		expect(errors).toHaveLength(2);
		expect(errors[0]).toBe(failure);
		expect(errors[1]).toBe(failure);
	});

	test("routes a synchronous callback failure to onError", async () => {
		const failure = new Error("sync failure");
		const errors: unknown[] = [];
		let calls = 0;
		const timer = new RecurringTimer(
			() => {
				calls++;
				timer.stop();

				throw failure;
			},
			5,
			(error) => {
				errors.push(error);
			},
		);

		timer.start();
		await Bun.sleep(20);

		expect(calls).toBe(1);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toBe(failure);
	});
});
