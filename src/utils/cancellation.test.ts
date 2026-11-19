import { describe, expect, test } from "bun:test";
import { mapConcurrent } from "@/utils/promise.utils";
import { CancellationError, throwIfAborted, timeoutSignal } from "./cancellation.utils";

describe("timeoutSignal", () => {
	test("aborts once the deadline passes", async () => {
		const signal = timeoutSignal(1);

		await new Promise<void>((resolve) => {
			signal.addEventListener("abort", () => resolve(), { once: true });
		});

		expect(signal.aborted).toBe(true);
	});

	test("aborts with the parent's reason when the parent aborts first", () => {
		const controller = new AbortController();
		const signal = timeoutSignal(60_000, controller.signal);
		const reason = new CancellationError();

		controller.abort(reason);

		expect(signal.aborted).toBe(true);
		expect(signal.reason).toBe(reason);
	});
});

describe("worker cancellation", () => {
	test("throws the cancellation error when a signal is aborted", () => {
		const controller = new AbortController();
		controller.abort(new CancellationError());

		expect(() => throwIfAborted(controller.signal)).toThrow(CancellationError);
	});

	test("stops scheduling new concurrent work after cancellation", async () => {
		const controller = new AbortController();
		const processed: number[] = [];

		await expect(
			mapConcurrent(
				[1, 2, 3, 4],
				1,
				(value) => {
					processed.push(value);
					if (value === 2) controller.abort(new CancellationError());

					return Promise.resolve(value);
				},
				controller.signal,
			),
		).rejects.toBeInstanceOf(CancellationError);

		expect(processed).toEqual([1, 2]);
	});
});
