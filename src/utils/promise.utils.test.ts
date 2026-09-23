import { describe, expect, it, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { file, write } from "bun";
import { PromiseUtils } from "./promise.utils";

describe("PromiseUtils.mapConcurrent", () => {
	it("preserves order while enforcing the concurrency limit", async () => {
		let active = 0;
		let maxActive = 0;

		const result = await PromiseUtils.mapConcurrent([30, 10, 20, 5], 2, async (delay) => {
			active++;
			maxActive = Math.max(maxActive, active);
			await PromiseUtils.sleep(delay);
			active--;

			return delay;
		});

		expect(result).toEqual([30, 10, 20, 5]);
		expect(maxActive).toBe(2);
	});

	it("rejects an invalid concurrency value", async () => {
		await expect(PromiseUtils.mapConcurrent([1], 0, async (value) => value)).rejects.toThrow("Concurrency must be a positive integer");
	});
});

describe("PromiseUtils.waitForFile", () => {
	it("resolves immediately if file already exists", async () => {
		const tempPath = join(tmpdir(), `reelvault-test-waitforfile-exists-${Date.now()}.txt`);
		await write(tempPath, "hello");
		try {
			await expect(PromiseUtils.waitForFile(tempPath, 1000)).resolves.toBeUndefined();
		} finally {
			await file(tempPath)
				.delete()
				.catch(() => {
					// nothing to clean up
				});
		}
	});

	it("resolves when file is written asynchronously", async () => {
		const tempPath = join(tmpdir(), `reelvault-test-waitforfile-async-${Date.now()}.txt`);
		try {
			const waitPromise = PromiseUtils.waitForFile(tempPath, 2000, 50);
			await PromiseUtils.sleep(50);
			await write(tempPath, "created");
			await expect(waitPromise).resolves.toBeUndefined();
		} finally {
			await file(tempPath)
				.delete()
				.catch(() => {
					// nothing to clean up
				});
		}
	});

	it("rejects when file does not appear within timeout", async () => {
		const nonExistentPath = join(tmpdir(), `reelvault-test-nonexistent-${Date.now()}.txt`);
		await expect(PromiseUtils.waitForFile(nonExistentPath, 100, 20)).rejects.toThrow("Timeout waiting for file");
	});
});

describe("PromiseUtils.waitForFile abort support", () => {
	it("rejects immediately when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();

		await expect(
			PromiseUtils.waitForFile(join(tmpdir(), `reelvault-test-aborted-${Date.now()}.txt`), 1000, 20, controller.signal),
		).rejects.toThrow();
	});

	it("rejects and stops waiting when the signal aborts mid-wait", async () => {
		const controller = new AbortController();
		const tempPath = join(tmpdir(), `reelvault-test-abort-midwait-${Date.now()}.txt`);

		const waitPromise = PromiseUtils.waitForFile(tempPath, 10_000, 20, controller.signal);
		await PromiseUtils.sleep(20);
		controller.abort();

		await expect(waitPromise).rejects.toThrow();
		// The file must never be created — the wait must end because of the abort,
		// not because the file appeared.
		expect(await file(tempPath).exists()).toBe(false);
	});

	it("resolves normally when no signal is aborted", async () => {
		const tempPath = join(tmpdir(), `reelvault-test-abort-unaffected-${Date.now()}.txt`);
		try {
			const waitPromise = PromiseUtils.waitForFile(tempPath, 2000, 20);
			await PromiseUtils.sleep(20);
			await write(tempPath, "created");
			await expect(waitPromise).resolves.toBeUndefined();
		} finally {
			await file(tempPath)
				.delete()
				.catch(() => {
					// nothing to clean up
				});
		}
	});
});

describe("PromiseUtils.createSemaphore", () => {
	test("enforces concurrency limit", async () => {
		const sem = PromiseUtils.createSemaphore(2);
		expect(sem.activeCount).toBe(0);
		expect(sem.queuedCount).toBe(0);

		await sem.acquire();
		await sem.acquire();
		expect(sem.activeCount).toBe(2);
		expect(sem.queuedCount).toBe(0);

		let thirdAcquired = false;
		const third = sem.acquire().then(() => {
			thirdAcquired = true;
		});

		expect(sem.queuedCount).toBe(1);
		expect(thirdAcquired).toBe(false);

		sem.release();
		await third;
		expect(thirdAcquired).toBe(true);
		expect(sem.activeCount).toBe(2);

		sem.release();
		sem.release();
		expect(sem.activeCount).toBe(0);
	});

	test("rejects immediately when signal is already aborted", async () => {
		const sem = PromiseUtils.createSemaphore(1);
		const controller = new AbortController();
		controller.abort(new Error("Pre-aborted"));

		await expect(sem.acquire(controller.signal)).rejects.toThrow("Pre-aborted");
		expect(sem.activeCount).toBe(0);
	});

	test("rejects and unblocks queue when signal aborts while waiting", async () => {
		const sem = PromiseUtils.createSemaphore(1);
		await sem.acquire();

		const controller = new AbortController();
		const queued = sem.acquire(controller.signal);
		expect(sem.queuedCount).toBe(1);

		controller.abort(new Error("Cancelled while waiting"));
		await expect(queued).rejects.toThrow("Cancelled while waiting");

		// The slot freed by release goes to a subsequent acquire, not the aborted one
		let nextAcquired = false;
		const next = sem.acquire().then(() => {
			nextAcquired = true;
		});

		sem.release();
		await next;
		expect(nextAcquired).toBe(true);
		sem.release();
	});

	test("run executes and releases cleanly", async () => {
		const sem = PromiseUtils.createSemaphore(1);
		const result = await sem.run(() => {
			expect(sem.activeCount).toBe(1);

			return 42;
		});
		expect(result).toBe(42);
		expect(sem.activeCount).toBe(0);

		await expect(
			sem.run(() => {
				throw new Error("Boom");
			}),
		).rejects.toThrow("Boom");
		expect(sem.activeCount).toBe(0);
	});
});
