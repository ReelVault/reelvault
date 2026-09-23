import { describe, expect, test } from "bun:test";
import { LibraryRunLock } from "./library-run.lock";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
	let capturedResolve!: (value: T) => void;
	let capturedReject!: (error: unknown) => void;
	const promise = new Promise<T>((resolve, reject) => {
		capturedResolve = resolve;
		capturedReject = reject;
	});

	return { promise, resolve: capturedResolve, reject: capturedReject };
}

describe("LibraryRunLock", () => {
	test("runs tasks for the same key sequentially in arrival order", async () => {
		const lock = new LibraryRunLock();
		const order: string[] = [];
		const first = deferred<void>();
		const run1 = lock.run("library-1", () => {
			order.push("first-start");

			return first.promise;
		});
		const run2 = lock.run("library-1", async () => {
			order.push("second-start");

			return await Promise.resolve("second-result");
		});

		await Promise.resolve();
		expect(order).toEqual(["first-start"]);
		first.resolve(undefined);
		await expect(run1).resolves.toBeUndefined();
		await expect(run2).resolves.toBe("second-result");
		expect(order).toEqual(["first-start", "second-start"]);
	});

	test("different keys run concurrently", async () => {
		const lock = new LibraryRunLock();
		const order: string[] = [];
		const gate = deferred<void>();
		const blocked = lock.run("library-1", () => gate.promise);
		const independent = lock.run("library-2", async () => {
			order.push("library-2");

			return await Promise.resolve("done");
		});

		await expect(independent).resolves.toBe("done");
		expect(order).toEqual(["library-2"]);
		gate.resolve(undefined);
		await expect(blocked).resolves.toBeUndefined();
	});

	test("a failed previous run does not block the next one", async () => {
		const lock = new LibraryRunLock();
		const failing = lock.run("library-1", () => Promise.reject(new Error("scan blew up")));

		await expect(failing).rejects.toThrow("scan blew up");

		await expect(lock.run("library-1", async () => "recovered")).resolves.toBe("recovered");
	});

	test("the lock is released after the run settles, so a new run starts immediately", async () => {
		const lock = new LibraryRunLock();
		await lock.run("library-1", async () => "first");

		await expect(lock.run("library-1", async () => "second")).resolves.toBe("second");
	});

	test("a queued run still receives its own rejection without poisoning the lock", async () => {
		const lock = new LibraryRunLock();
		const gate = deferred<void>();
		const first = lock.run("library-1", () => gate.promise);
		const second = lock.run("library-1", () => Promise.reject(new Error("second failed")));

		gate.resolve(undefined);
		await expect(first).resolves.toBeUndefined();
		await expect(second).rejects.toThrow("second failed");

		await expect(lock.run("library-1", async () => "third")).resolves.toBe("third");
	});
});
