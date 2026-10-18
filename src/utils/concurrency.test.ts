import { describe, expect, test } from "bun:test";
import { KeyedMutex } from "./concurrency.utils";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
	let capturedResolve!: (value: T) => void;
	let capturedReject!: (error: unknown) => void;
	const promise = new Promise<T>((resolve, reject) => {
		capturedResolve = resolve;
		capturedReject = reject;
	});

	return { promise, resolve: capturedResolve, reject: capturedReject };
}

describe("keyed mutex", () => {
	test("serialises overlapping sections of one key in submission order", async () => {
		const mutex = new KeyedMutex();
		const order: string[] = [];
		const task = (name: string, delayMs: number) =>
			mutex.runExclusive("global", async () => {
				order.push(`${name}:start`);
				await Bun.sleep(delayMs);
				order.push(`${name}:end`);
			});

		await Promise.all([task("a", 20), task("b", 1)]);
		expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
	});

	test("a failing section does not block the next one", async () => {
		const mutex = new KeyedMutex();
		const boom = new Error("boom");
		await expect(mutex.runExclusive("global", () => Promise.reject(boom))).rejects.toBe(boom);
		await expect(mutex.runExclusive("global", async () => "ok")).resolves.toBe("ok");
	});

	test("serialises only the same key and lets other keys run concurrently", async () => {
		const mutex = new KeyedMutex();
		const order: string[] = [];
		const task = (key: string, name: string, delayMs: number) =>
			mutex.runExclusive(key, async () => {
				order.push(`${name}:start`);
				await Bun.sleep(delayMs);
				order.push(`${name}:end`);
			});

		await Promise.all([task("x", "x1", 20), task("x", "x2", 1), task("y", "y1", 1)]);

		// Same key is strict FIFO.
		expect(order.indexOf("x1:end")).toBeLessThan(order.indexOf("x2:start"));
		// A different key starts before the same-key queue drains.
		expect(order.indexOf("y1:start")).toBeLessThan(order.indexOf("x2:start"));
	});

	test("a queued run still receives its own rejection without poisoning the lock", async () => {
		const mutex = new KeyedMutex();
		const gate = deferred<void>();
		const first = mutex.runExclusive("library-1", () => gate.promise);
		const secondError = new Error("second failed");
		const second = mutex.runExclusive("library-1", () => Promise.reject(secondError));
		const secondOutcome = second.then(
			() => undefined,
			(error: unknown) => error,
		);

		gate.resolve(undefined);
		await expect(first).resolves.toBeUndefined();
		expect(await secondOutcome).toBe(secondError);

		await expect(mutex.runExclusive("library-1", async () => "third")).resolves.toBe("third");
	});
});
