import { describe, expect, test } from "bun:test";
import { QueryFields } from "./fields";

describe("QueryFields.includes", () => {
	test("loads all relations when no projection was requested", () => {
		expect(QueryFields.includes(undefined, "genres")).toBeTrue();
	});

	test("matches a relation selected directly or through a nested field", () => {
		const fields = QueryFields.parse({ fields: "id,genres.id" });

		expect(QueryFields.includes(fields, "genres")).toBeTrue();
		expect(QueryFields.includes(fields, "images")).toBeFalse();
	});

	test("rejects oversized field queries", () => {
		expect(() => QueryFields.parse({ fields: "a".repeat(2049) })).toThrow("2048 characters");
	});

	test("rejects too many fields", () => {
		expect(() => QueryFields.parse({ fields: Array.from({ length: 65 }, (_, index) => `field${index}`).join(",") })).toThrow(
			"more than 64 fields",
		);
	});

	test("rejects overly deep fields", () => {
		expect(() => QueryFields.parse({ fields: "one.two.three.four.five" })).toThrow("deeper than 4 levels");
	});
});
