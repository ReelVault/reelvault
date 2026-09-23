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
});
