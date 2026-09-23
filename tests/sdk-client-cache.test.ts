import { describe, expect, test } from "bun:test";
import { TtlCache } from "@reelvault/sdk/client";

describe("sdk TtlCache", () => {
	test("evicts oldest entries beyond the cap", () => {
		const cache = new TtlCache();
		for (let index = 0; index < 600; index++) cache.set(`key-${index}`, index, 60_000);

		expect(cache.get("key-0")).toBeUndefined();
		expect(cache.get("key-599")).toBe(599);
	});

	test("returns a clone so a caller cannot corrupt the cached value", () => {
		const cache = new TtlCache();
		cache.set("shared", { a: 1 }, 60_000);

		const first = cache.get("shared");
		if (typeof first === "object" && first !== null) Reflect.set(first, "a", 99);

		expect(cache.get("shared")).toEqual({ a: 1 });
	});
});
