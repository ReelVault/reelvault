import { describe, expect, test } from "bun:test";
import { batchChunks } from "./batch-chunker";

function collect<T>(items: readonly T[], size: number, startCursor?: number): Array<{ items: T[]; nextCursor: number }> {
	return startCursor === undefined ? [...batchChunks(items, size)] : [...batchChunks(items, size, startCursor)];
}

describe("batchChunks", () => {
	test("yields nothing for empty input", () => {
		expect(collect([], 3)).toEqual([]);
	});

	test("splits even and uneven lists, with a partial last batch", () => {
		expect(collect(["a", "b", "c", "d", "e"], 2)).toEqual([
			{ items: ["a", "b"], nextCursor: 2 },
			{ items: ["c", "d"], nextCursor: 4 },
			{ items: ["e"], nextCursor: 5 },
		]);
	});

	test("one batch when the size covers the whole list", () => {
		expect(collect([1, 2, 3], 10)).toEqual([{ items: [1, 2, 3], nextCursor: 3 }]);
	});

	test("resumes from a checkpoint cursor without re-emitting earlier items", () => {
		expect(collect(["/a", "/b", "/c", "/d", "/e"], 2, 1)).toEqual([
			{ items: ["/b", "/c"], nextCursor: 3 },
			{ items: ["/d", "/e"], nextCursor: 5 },
		]);
	});

	test("a cursor at or past the end yields nothing", () => {
		expect(collect([1, 2], 2, 2)).toEqual([]);
		expect(collect([1, 2], 2, 7)).toEqual([]);
	});

	test("never mutates the source array", () => {
		const items = Object.freeze([1, 2, 3]);

		expect(collect(items, 2)).toEqual([
			{ items: [1, 2], nextCursor: 2 },
			{ items: [3], nextCursor: 3 },
		]);
	});
});
