import { describe, expect, test } from "bun:test";
import { PromiseUtils } from "@/utils/promise.utils";
import { throwIfAborted, WorkerCancellationError } from "./worker-cancellation";

describe("worker cancellation", () => {
	test("throws the cancellation error when a signal is aborted", () => {
		const controller = new AbortController();
		controller.abort(new WorkerCancellationError());

		expect(() => throwIfAborted(controller.signal)).toThrow(WorkerCancellationError);
	});

	test("stops scheduling new concurrent work after cancellation", () => {
		const controller = new AbortController();
		const processed: number[] = [];

		expect(
			PromiseUtils.mapConcurrent(
				[1, 2, 3, 4],
				1,
				(value) => {
					processed.push(value);
					if (value === 2) controller.abort(new WorkerCancellationError());

					return Promise.resolve(value);
				},
				controller.signal,
			),
		).rejects.toBeInstanceOf(WorkerCancellationError);

		expect(processed).toEqual([1, 2]);
	});
});
