import { describe, expect, it } from "bun:test";
import { chunk, groupBy, toMap, unique } from "./array.utils";

describe("array.utils", () => {
	describe("unique", () => {
		it("deduplicates raw array without selector", () => {
			expect(unique([1, 2, 2, 3, 1])).toEqual([1, 2, 3]);
			expect(unique(["a", "b", "a"])).toEqual(["a", "b"]);
			expect(unique([])).toEqual([]);
		});

		it("deduplicates with key selector", () => {
			const items = [
				{ id: "a", x: 1 },
				{ id: "b", x: 2 },
				{ id: "a", x: 3 },
			];
			expect(unique(items, (i) => i.id)).toEqual(["a", "b"]);
		});

		it("returns empty for empty input with key selector", () => {
			expect(unique([], (i: { id: string }) => i.id)).toEqual([]);
		});

		it("preserves first occurrence order", () => {
			const items = [{ id: "c" }, { id: "a" }, { id: "b" }, { id: "a" }];
			expect(unique(items, (i) => i.id)).toEqual(["c", "a", "b"]);
		});
	});

	describe("toMap", () => {
		it("builds a map by key selector", () => {
			const items = [
				{ id: "a", name: "Alice" },
				{ id: "b", name: "Bob" },
			];
			const m = toMap(items, (i) => i.id);
			expect(m.get("a")).toEqual({ id: "a", name: "Alice" });
			expect(m.size).toBe(2);
		});

		it("applies value selector", () => {
			const items = [
				{ id: "a", name: "Alice" },
				{ id: "b", name: "Bob" },
			];
			const m = toMap(
				items,
				(i) => i.id,
				(i) => i.name,
			);
			expect(m.get("a")).toBe("Alice");
		});

		it("handles empty arrays", () => {
			const m = toMap([], (i: { id: string }) => i.id);
			expect(m.size).toBe(0);
		});

		it("last duplicate key wins", () => {
			const items = [
				{ id: "a", name: "Alice" },
				{ id: "a", name: "Alicia" },
			];
			const m = toMap(items, (i) => i.id);
			expect(m.get("a")).toEqual({ id: "a", name: "Alicia" });
		});
	});

	describe("chunk", () => {
		it("chunks an array into equal batches", () => {
			const items = [1, 2, 3, 4, 5, 6];
			expect(chunk(items, 2)).toEqual([
				[1, 2],
				[3, 4],
				[5, 6],
			]);
		});

		it("handles remainders gracefully", () => {
			const items = [1, 2, 3, 4, 5];
			expect(chunk(items, 2)).toEqual([[1, 2], [3, 4], [5]]);
		});

		it("returns an empty array when given an empty input", () => {
			expect(chunk([], 3)).toEqual([]);
		});

		it("returns the entire array when chunk size is larger than length", () => {
			expect(chunk([1, 2], 5)).toEqual([[1, 2]]);
		});
	});

	describe("groupBy", () => {
		it("groups items by selected key", () => {
			const items = [
				{ id: "1", role: "admin" },
				{ id: "2", role: "user" },
				{ id: "3", role: "admin" },
			];
			const grouped = groupBy(items, (item) => item.role);
			expect(grouped.get("admin")).toEqual([
				{ id: "1", role: "admin" },
				{ id: "3", role: "admin" },
			]);
			expect(grouped.get("user")).toEqual([{ id: "2", role: "user" }]);
		});

		it("omits items where key is null or undefined", () => {
			const items = [
				{ id: "1", parentId: "p1" },
				{ id: "2", parentId: null },
				{ id: "3", parentId: undefined },
				{ id: "4", parentId: "p1" },
			];
			const grouped = groupBy(items, (item) => item.parentId);
			expect(grouped.size).toBe(1);
			expect(grouped.get("p1")).toEqual([
				{ id: "1", parentId: "p1" },
				{ id: "4", parentId: "p1" },
			]);
		});

		it("handles empty arrays", () => {
			const grouped = groupBy([], (item: { id: string }) => item.id);
			expect(grouped.size).toBe(0);
		});

		it("maps values using optional valueSelector", () => {
			const items = [
				{ category: "fruit", name: "apple" },
				{ category: "vegetable", name: "carrot" },
				{ category: "fruit", name: "banana" },
			];
			const grouped = groupBy(
				items,
				(item) => item.category,
				(item) => item.name,
			);
			expect(grouped.get("fruit")).toEqual(["apple", "banana"]);
			expect(grouped.get("vegetable")).toEqual(["carrot"]);
		});
	});
});
