import { describe, expect, test } from "bun:test";
import { SourceVersionCache } from "./source-version.cache";

describe("SourceVersionCache", () => {
	test("derives the version stamp from the source size and mtime", async () => {
		let statsCalls = 0;
		const cache = new SourceVersionCache({
			getStats: () => {
				statsCalls++;

				return Promise.resolve({ size: 1234, mtimeMs: 1_700_000_000_500.75 });
			},
		});

		expect(await cache.read("/images/src.png")).toBe("1234:1700000000500");
		expect(statsCalls).toBe(1);
	});

	test("caches the stamp per source path", async () => {
		let statsCalls = 0;
		const cache = new SourceVersionCache({
			getStats: () => {
				statsCalls++;

				return Promise.resolve({ size: 10, mtimeMs: 20 });
			},
		});

		await cache.read("/images/a.png");
		await cache.read("/images/a.png");
		await cache.read("/images/a.png");

		expect(statsCalls).toBe(1);
		expect(await cache.read("/images/b.png")).toBe("10:20");
		expect(statsCalls).toBe(2);
	});

	test("stamps a missing source file with the zero version", async () => {
		const cache = new SourceVersionCache({
			getStats: async () => null,
		});

		expect(await cache.read("/images/gone.png")).toBe("0");
	});

	test("holds two thousand source stamps before evicting the oldest", async () => {
		let statsCalls = 0;
		const cache = new SourceVersionCache({
			getStats: () => {
				statsCalls++;

				return Promise.resolve({ size: 1, mtimeMs: 2 });
			},
		});

		for (let index = 0; index < 2_000; index++) await cache.read(`/images/src-${index}.png`);
		expect(statsCalls).toBe(2_000);

		await cache.read("/images/src-0.png");
		expect(statsCalls).toBe(2_000);

		await cache.read("/images/src-2000.png");
		expect(statsCalls).toBe(2_001);

		// src-0 was just touched, so the next-oldest stamp is the one evicted.
		await cache.read("/images/src-1.png");
		expect(statsCalls).toBe(2_002);
	});
});
