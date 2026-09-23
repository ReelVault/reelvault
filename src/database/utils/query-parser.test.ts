import { describe, expect, mock, test } from "bun:test";
import { sql } from "drizzle-orm";
import { QueryUtils } from "./query-parser";

test("append_to_response extends an explicit fields projection", () => {
	const result = QueryUtils.parseStandard({ fields: "id,title,images,genres" });
	expect(result.fields.fields).toEqual(["id", "title", "images", "genres"]);
});

describe("buildWhereConditions", () => {
	test.each([0, false])("keeps the filter value %p", (value) => {
		const applyFilter = mock(() => sql`1 = 1`);

		QueryUtils.buildWhereConditions({ value }, { value: applyFilter });

		expect(applyFilter).toHaveBeenCalledWith(value);
	});

	test.each([undefined, null, ""])("skips the empty filter value %p", (value) => {
		const applyFilter = mock(() => sql`1 = 1`);

		QueryUtils.buildWhereConditions({ value }, { value: applyFilter });

		expect(applyFilter).not.toHaveBeenCalled();
	});
});
