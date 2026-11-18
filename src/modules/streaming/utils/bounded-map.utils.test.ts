import { describe, expect, test } from "bun:test";
import { BoundedMap } from "./bounded-map.utils";

describe("bounded map", () => {
	test("evicts the oldest entry when the hard cap is reached", () => {
		const map = new BoundedMap<number>({ maxEntries: 2 });
		map.set("a", 1);
		map.set("b", 2);
		map.set("c", 3);

		expect(map.get("a")).toBeUndefined();
		expect(map.get("b")).toBe(2);
		expect(map.get("c")).toBe(3);
	});

	test("re-setting a key refreshes it without evicting another entry", () => {
		const map = new BoundedMap<number>({ maxEntries: 2 });
		map.set("a", 1);
		map.set("b", 2);
		map.set("a", 3);
		map.set("c", 4);

		expect(map.get("a")).toBe(3);
		expect(map.get("b")).toBeUndefined();
		expect(map.get("c")).toBe(4);
	});

	test("prune removes only expired entries at the injected time", () => {
		const map = new BoundedMap<number>({ maxEntries: 10, now: () => 100 });
		map.set("old", 1);
		map.set("new", 2);

		map.prune((value, now) => now >= 100 && value === 1);

		expect(map.get("old")).toBeUndefined();
		expect(map.get("new")).toBe(2);
	});
});
