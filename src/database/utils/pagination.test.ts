import { describe, expect, test } from "bun:test";
import { QueryPagination } from "./pagination";

describe("QueryPagination", () => {
	test("clamps page and limit to configured bounds", () => {
		expect(QueryPagination.parse({ page: 200_000, limit: 9999 })).toEqual({
			page: 100_000,
			limit: 500,
			offset: 49_999_500,
		});
	});

	test("uses safe defaults", () => {
		expect(QueryPagination.parse({})).toEqual({ page: 1, limit: 20, offset: 0 });
	});
});
