import { describe, expect, it, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { file, write } from "bun";
import { createSemaphore, mapConcurrent, waitForFile } from "./promise.utils";

describe("mapConcurrent", () => {
	it("preserves order while enforcing the concurrency limit", async () => {
		let active = 0;
		let maxActive = 0;

		const result = await mapConcurrent([30, 10, 20, 5], 2, async (delay) => {
			active++;
			maxActive = Math.max(maxActive, active);
			await Bun.sleep(delay);
			active--;

			return delay;
		});

		expect(result).toEqual([30, 10, 20, 5]);
		expect(maxActive).toBe(2);
	});

	it("rejects an invalid concurrency value", async () => {
		await expect(mapConcurrent([1], 0, async (value) => value)).rejects.toMatchObject({
			category: "internal",
			code: "concurrency.invalid",
		});
	});
});

describe("waitForFile", () => {
	it("resolves immediately if file already exists", async () => {
		const tempPath = join(tmpdir(), `reelvault-test-waitforfile-exists-${Date.now()}.txt`);
		await write(tempPath, "hello");
		try {
			await expect(waitForFile(tempPath, 1000)).resolves.toBeUndefined();
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
			const waitPromise = waitForFile(tempPath, 2000, 50);
			await Bun.sleep(50);
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
		await expect(waitForFile(nonExistentPath, 100, 20)).rejects.toMatchObject({
			category: "timeout",
			code: "file.wait_timeout",
		});
	});
});

describe("waitForFile abort support", () => {
	it("rejects with the abort reason when the signal is already aborted", async () => {
		const controller = new AbortController();
		const reason = new Error("Cancelled before the wait");
		controller.abort(reason);

		await expect(waitForFile(join(tmpdir(), `reelvault-test-aborted-${Date.now()}.txt`), 1000, 20, controller.signal)).rejects.toBe(reason);
	});

	it("rejects with the abort reason when the signal aborts mid-wait", async () => {
		const controller = new AbortController();
		const reason = new Error("Cancelled mid-wait");
		const tempPath = join(tmpdir(), `reelvault-test-abort-midwait-${Date.now()}.txt`);

		const waitPromise = waitForFile(tempPath, 10_000, 20, controller.signal);
		await Bun.sleep(20);
		controller.abort(reason);

		// Identity: a timeout or the file appearing would settle the wait with a different outcome.
		await expect(waitPromise).rejects.toBe(reason);
	});

	it("resolves normally when no signal is aborted", async () => {
		const tempPath = join(tmpdir(), `reelvault-test-abort-unaffected-${Date.now()}.txt`);
		try {
			const waitPromise = waitForFile(tempPath, 2000, 20);
			await Bun.sleep(20);
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

describe("createSemaphore", () => {
	test("enforces concurrency limit", async () => {
		const sem = createSemaphore(2);
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
		const sem = createSemaphore(1);
		const controller = new AbortController();
		const reason = new Error("Pre-aborted");
		controller.abort(reason);

		await expect(sem.acquire(controller.signal)).rejects.toBe(reason);
		expect(sem.activeCount).toBe(0);
	});

	test("rejects and unblocks queue when signal aborts while waiting", async () => {
		const sem = createSemaphore(1);
		await sem.acquire();

		const controller = new AbortController();
		const queued = sem.acquire(controller.signal);
		expect(sem.queuedCount).toBe(1);

		const cancelled = new Error("Cancelled while waiting");
		controller.abort(cancelled);
		await expect(queued).rejects.toBe(cancelled);

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
		const boom = new Error("Boom");
		const sem = createSemaphore(1);
		const result = await sem.run(() => {
			expect(sem.activeCount).toBe(1);

			return 42;
		});
		expect(result).toBe(42);
		expect(sem.activeCount).toBe(0);

		await expect(
			sem.run(() => {
				throw boom;
			}),
		).rejects.toBe(boom);
		expect(sem.activeCount).toBe(0);
	});
});
