import { describe, expect, test } from "bun:test";
import { QueryFields } from "./fields";

describe("QueryFields.parse limits", () => {
	/** The error a call throws, so its code and params can be asserted. */
	function thrownBy(call: () => unknown): unknown {
		try {
			call();
		} catch (error) {
			return error;
		}

		return undefined;
	}

	test("a field list longer than the limit answers the too-long code with the limit", () => {
		expect(thrownBy(() => QueryFields.parse({ fields: "a".repeat(2049) }))).toMatchObject({
			code: "validation.fields_too_long",
			params: { max: 2048 },
		});
	});

	test("more fields than the limit answers the too-many code with the limit", () => {
		const fields = Array.from({ length: 65 }, (_, index) => `f${index}`).join(",");

		expect(thrownBy(() => QueryFields.parse({ fields }))).toMatchObject({
			code: "validation.fields_too_many",
			params: { max: 64 },
		});
	});

	test("a field nested deeper than the limit answers the too-deep code with the limit", () => {
		expect(thrownBy(() => QueryFields.parse({ fields: "a.b.c.d.e" }))).toMatchObject({
			code: "validation.fields_too_deep",
			params: { max: 4 },
		});
	});
});

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
