import { describe, expect, test } from "bun:test";
import { KeyedMutex } from "./concurrency";

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
		await expect(mutex.runExclusive("global", () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
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
});

describe("library run lock semantics", () => {
	test("runs tasks for the same key sequentially in arrival order", async () => {
		const lock = new KeyedMutex();
		const order: string[] = [];
		const first = deferred<void>();
		const run1 = lock.runExclusive("library-1", () => {
			order.push("first-start");

			return first.promise;
		});
		const run2 = lock.runExclusive("library-1", async () => {
			order.push("second-start");

			return await Promise.resolve("second-result");
		});

		await Bun.sleep(0);
		expect(order).toEqual(["first-start"]);
		first.resolve(undefined);
		await expect(run1).resolves.toBeUndefined();
		await expect(run2).resolves.toBe("second-result");
		expect(order).toEqual(["first-start", "second-start"]);
	});

	test("different keys run concurrently", async () => {
		const lock = new KeyedMutex();
		const order: string[] = [];
		const gate = deferred<void>();
		const blocked = lock.runExclusive("library-1", () => gate.promise);
		const independent = lock.runExclusive("library-2", async () => {
			order.push("library-2");

			return await Promise.resolve("done");
		});

		await expect(independent).resolves.toBe("done");
		expect(order).toEqual(["library-2"]);
		gate.resolve(undefined);
		await expect(blocked).resolves.toBeUndefined();
	});

	test("a failed previous run does not block the next one", async () => {
		const lock = new KeyedMutex();
		const failing = lock.runExclusive("library-1", () => Promise.reject(new Error("scan blew up")));

		await expect(failing).rejects.toThrow("scan blew up");

		await expect(lock.runExclusive("library-1", async () => "recovered")).resolves.toBe("recovered");
	});

	test("the lock is released after the run settles, so a new run starts immediately", async () => {
		const lock = new KeyedMutex();
		await lock.runExclusive("library-1", async () => "first");

		await expect(lock.runExclusive("library-1", async () => "second")).resolves.toBe("second");
	});

	test("a queued run still receives its own rejection without poisoning the lock", async () => {
		const lock = new KeyedMutex();
		const gate = deferred<void>();
		const first = lock.runExclusive("library-1", () => gate.promise);
		const second = lock.runExclusive("library-1", () => Promise.reject(new Error("second failed")));
		const secondMessage = second.then(
			() => "resolved",
			(error: Error) => error.message,
		);

		gate.resolve(undefined);
		await expect(first).resolves.toBeUndefined();
		expect(await secondMessage).toBe("second failed");

		await expect(lock.runExclusive("library-1", async () => "third")).resolves.toBe("third");
	});
});
