import { describe, expect, test } from "bun:test";
import { RecurringTimer } from "./recurring-timer.utils";

describe("RecurringTimer", () => {
	test("does not start until start() and a second start does not double the interval", async () => {
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
		const errors: unknown[] = [];
		let calls = 0;
		const timer = new RecurringTimer(
			() => {
				calls++;

				return Promise.reject(new Error("async failure"));
			},
			5,
			(error) => {
				errors.push(error);
			},
		);

		timer.start();
		await Bun.sleep(30);
		timer.stop();

		expect(calls).toBeGreaterThan(0);
		expect(errors.length).toBeGreaterThan(0);
	});

	test("routes a synchronous callback failure to onError", async () => {
		const errors: unknown[] = [];
		const timer = new RecurringTimer(
			() => {
				throw new Error("sync failure");
			},
			5,
			(error) => {
				errors.push(error);
			},
		);

		timer.start();
		await Bun.sleep(20);
		timer.stop();

		expect(errors.length).toBeGreaterThan(0);
	});
});
