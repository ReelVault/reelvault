import { describe, expect, test } from "bun:test";
import { type SQL, sql } from "drizzle-orm";
import { SQLiteDialect } from "drizzle-orm/sqlite-core";
import { applySorting } from "@/integrations/drizzle-orm/query/parsing/sorting.parser";

const dialect = new SQLiteDialect();

function toSql(expression: SQL): string {
	return dialect.sqlToQuery(expression).sql;
}

describe("applySorting", () => {
	test("orders the column in the requested direction", () => {
		const column = sql`title`;

		expect(toSql(applySorting(column, "asc"))).toBe("title asc");
		expect(toSql(applySorting(column, "desc"))).toBe("title desc");
	});

	test("throws when no column is given", () => {
		expect(() => applySorting(undefined, "asc")).toThrow(
			expect.objectContaining({ category: "internal", code: "query.sort_column_missing" }),
		);
	});
});
