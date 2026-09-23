import { describe, expect, test } from "bun:test";
import { KeyedMutex, Mutex } from "./mutex";

describe("mutex", () => {
	test("serialises overlapping sections in submission order", async () => {
		const mutex = new Mutex();
		const order: string[] = [];
		const task = (name: string, delayMs: number) =>
			mutex.runExclusive(async () => {
				order.push(`${name}:start`);
				await Bun.sleep(delayMs);
				order.push(`${name}:end`);
			});

		await Promise.all([task("a", 20), task("b", 1)]);
		expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
	});

	test("a failing section does not block the next one", async () => {
		const mutex = new Mutex();
		await expect(mutex.runExclusive(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
		await expect(mutex.runExclusive(async () => "ok")).resolves.toBe("ok");
	});
});

describe("keyed mutex", () => {
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
