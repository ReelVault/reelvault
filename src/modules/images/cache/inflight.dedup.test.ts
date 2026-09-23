import { describe, expect, test } from "bun:test";
import { InflightDedup } from "./inflight.dedup";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((_resolve, _reject) => {
		resolve = _resolve;
		reject = _reject;
	});

	return { promise, resolve, reject };
}

describe("InflightDedup", () => {
	test("coalesces concurrent calls for the same key into one task", async () => {
		const dedup = new InflightDedup<string>();
		let runs = 0;
		const gate = deferred<string>();
		const task = () => {
			runs++;

			return gate.promise;
		};

		const first = dedup.run("key-1", task);
		const second = dedup.run("key-1", task);

		gate.resolve("value");
		expect(await first).toBe("value");
		expect(await second).toBe("value");
		expect(runs).toBe(1);
	});

	test("runs the task again once the previous one settled", async () => {
		const dedup = new InflightDedup<number>();
		let runs = 0;
		const task = () => {
			runs++;

			return Promise.resolve(runs);
		};

		expect(await dedup.run("key-1", task)).toBe(1);
		expect(await dedup.run("key-1", task)).toBe(2);
		expect(runs).toBe(2);
	});

	test("keeps independent keys independent", async () => {
		const dedup = new InflightDedup<string>();

		expect(await Promise.all([dedup.run("a", async () => "A"), dedup.run("b", async () => "B")])).toEqual(["A", "B"]);
	});

	test("propagates the failure to every waiter without poisoning the next run", async () => {
		const dedup = new InflightDedup<string>();
		let runs = 0;
		const gate = deferred<string>();
		const task = () => {
			runs++;

			return gate.promise;
		};

		const first = dedup.run("key-1", task);
		const second = dedup.run("key-1", task);
		first.catch(() => undefined);
		second.catch(() => undefined);
		gate.reject(new Error("optimize failed"));

		await expect(first).rejects.toThrow("optimize failed");
		await expect(second).rejects.toThrow("optimize failed");
		expect(runs).toBe(1);

		expect(await dedup.run("key-1", async () => "recovered")).toBe("recovered");

		expect(await dedup.run("key-1", async () => "recovered")).toBe("recovered");
	});
});
