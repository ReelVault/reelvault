import { beforeEach, describe, expect, test } from "bun:test";
import { cachedCount, clearCountCache, filterSignature } from "./row-count.cache";

describe("filterSignature", () => {
	const filterMap = { title: () => undefined, genre: () => undefined };

	test("keeps only the declared filter keys", () => {
		const signature = filterSignature({ title: "a", page: 2, limit: 20, sortBy: "title", fields: "id" }, filterMap);
		expect(signature).toEqual([["title", "a"]]);
	});

	test("drops undefined filters", () => {
		expect(filterSignature({ title: undefined, genre: "Drama" }, filterMap)).toEqual([["genre", "Drama"]]);
	});

	test("returns an empty signature for non-objects", () => {
		expect(filterSignature(undefined, filterMap)).toEqual([]);
		expect(filterSignature("nope", filterMap)).toEqual([]);
	});
});

describe("cachedCount", () => {
	beforeEach(() => {
		clearCountCache();
	});

	test("runs one count for concurrent requests with the same filters", async () => {
		let runs = 0;
		const count = async () => {
			runs++;
			await Bun.sleep(5);

			return 42;
		};

		const totals = await Promise.all([
			cachedCount("dedupe-table", { status: "open" }, count),
			cachedCount("dedupe-table", { status: "open" }, count),
		]);

		expect(totals).toEqual([42, 42]);
		expect(runs).toBe(1);
	});

	test("answers a repeated count from the cache and counts again for other filters", async () => {
		const totals = [
			await cachedCount("filter-table", { status: "open" }, () => Promise.resolve(3)),
			await cachedCount("filter-table", { status: "open" }, () => Promise.resolve(99)),
			await cachedCount("filter-table", { status: "closed" }, () => Promise.resolve(7)),
		];

		expect(totals).toEqual([3, 3, 7]);
	});
});
