import { describe, expect, test } from "bun:test";
import { filterSignature } from "./table-access";

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
