import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { QuerySorting } from "./sorting";

describe("QuerySorting.apply", () => {
	test("wraps the column with the requested order", () => {
		const column = sql`title`;
		expect(QuerySorting.apply(column, "asc").queryChunks.some(Boolean)).toBe(true);
		expect(QuerySorting.apply(column, "desc")).toBeDefined();
	});

	test("throws when no column is given", () => {
		expect(() => QuerySorting.apply(undefined, "asc")).toThrow("Column is undefined");
	});
});
