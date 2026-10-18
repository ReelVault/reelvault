import { describe, expect, test } from "bun:test";
import { type SQL, sql } from "drizzle-orm";
import { SQLiteDialect } from "drizzle-orm/sqlite-core";
import { QuerySorting } from "./sorting.parser";

const dialect = new SQLiteDialect();

function toSql(expression: SQL): string {
	return dialect.sqlToQuery(expression).sql;
}

describe("QuerySorting.apply", () => {
	test("orders the column in the requested direction", () => {
		const column = sql`title`;

		expect(toSql(QuerySorting.apply(column, "asc"))).toBe("title asc");
		expect(toSql(QuerySorting.apply(column, "desc"))).toBe("title desc");
	});

	test("throws when no column is given", () => {
		expect(() => QuerySorting.apply(undefined, "asc")).toThrow(
			expect.objectContaining({ category: "internal", code: "query.sort_column_missing" }),
		);
	});
});
