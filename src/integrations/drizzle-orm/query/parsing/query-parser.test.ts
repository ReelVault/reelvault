import { describe, expect, test } from "bun:test";
import { type SQL, sql } from "drizzle-orm";
import { SQLiteDialect } from "drizzle-orm/sqlite-core";
import { buildWhereConditions } from "@/integrations/drizzle-orm/query/parsing/query.parser";

const dialect = new SQLiteDialect();

/** Bound parameters of a built condition, or undefined when the filters built none. */
function paramsOf(condition: SQL | undefined): unknown[] | undefined {
	return condition ? dialect.sqlToQuery(condition).params : undefined;
}

const filterOnPriority = (value: unknown) => sql`priority = ${value}`;

describe("buildWhereConditions", () => {
	test.each([0, false])("keeps the falsy filter value %p as a condition", (value) => {
		const where = buildWhereConditions({ value }, { value: filterOnPriority });

		expect(paramsOf(where)).toEqual([value]);
	});

	test.each([undefined, null, ""])("builds no condition for the empty filter value %p", (value) => {
		expect(buildWhereConditions({ value }, { value: filterOnPriority })).toBeUndefined();
	});
});
