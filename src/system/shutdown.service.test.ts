import { afterEach, describe, expect, test } from "bun:test";
import { type MethodStub, stubMethod } from "../../tests/helpers/method-stub.helper";
import { Shutdown, type ShutdownStep } from "./shutdown.service";

const activeStubs: MethodStub[] = [];

afterEach(() => {
	for (const stub of activeStubs.splice(0).toReversed()) stub.restore();
});

/** The shutdown path ends in `process.exit`; keep the test process alive and observe the code. */
function stubExit() {
	const stub = stubMethod(process, "exit", () => undefined);
	activeStubs.push(stub);

	return stub;
}

describe("Shutdown per-step budget", () => {
	test("reports a shutdown as in progress while its steps run", async () => {
		const shutdown = new Shutdown([]);
		const exit = stubExit();

		const stopping = shutdown.shutdown("test");
		expect(shutdown.inProgress).toBeTrue();
		await stopping;

		expect(exit.calls).toEqual([[0]]);
	});

	test("runs every later step after an earlier step misses its budget", async () => {
		let afterRan = false;
		const steps: ShutdownStep[] = [
			{
				name: "slow",
				message: "slow step",
				timeoutMs: 20,
				run: async () =>
					await new Promise<never>(() => {
						// Intentionally never settles: the per-step deadline is the behavior under test.
					}),
			},
			{
				name: "after",
				message: "after step",
				run: () => {
					afterRan = true;
				},
			},
		];
		const exit = stubExit();

		await new Shutdown(steps).shutdown("test");

		expect(afterRan).toBeTrue();
		expect(exit.calls).toEqual([[1]]);
	});

	test("runs the forced fallback when the step times out", async () => {
		let fallbackRan = false;
		const steps: ShutdownStep[] = [
			{
				name: "http",
				message: "http step",
				timeoutMs: 20,
				run: async () =>
					await new Promise<never>(() => {
						// A drain that never completes.
					}),
				onTimeout: () => {
					fallbackRan = true;
				},
			},
		];
		const exit = stubExit();

		await new Shutdown(steps).shutdown("test");

		expect(fallbackRan).toBeTrue();
		expect(exit.calls).toEqual([[1]]);
	});
});
