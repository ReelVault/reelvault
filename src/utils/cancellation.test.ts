import { describe, expect, test } from "bun:test";
import { PromiseUtils } from "@/utils/promise.utils";
import { CancellationError, throwIfAborted } from "./cancellation.utils";

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
			PromiseUtils.mapConcurrent(
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
