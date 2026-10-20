import { describe, expect, test } from "bun:test";
import { includesField, parseFields } from "@/integrations/drizzle-orm/query/parsing/fields.parser";

describe("parseFields limits", () => {
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
		expect(thrownBy(() => parseFields({ fields: "a".repeat(2049) }))).toMatchObject({
			code: "validation.fields_too_long",
			params: { max: 2048 },
		});
	});

	test("more fields than the limit answers the too-many code with the limit", () => {
		const fields = Array.from({ length: 65 }, (_, index) => `f${index}`).join(",");

		expect(thrownBy(() => parseFields({ fields }))).toMatchObject({
			code: "validation.fields_too_many",
			params: { max: 64 },
		});
	});

	test("a field nested deeper than the limit answers the too-deep code with the limit", () => {
		expect(thrownBy(() => parseFields({ fields: "a.b.c.d.e" }))).toMatchObject({
			code: "validation.fields_too_deep",
			params: { max: 4 },
		});
	});
});

describe("includesField", () => {
	test("loads all relations when no projection was requested", () => {
		expect(includesField(undefined, "genres")).toBeTrue();
	});

	test("matches a relation selected directly or through a nested field", () => {
		const fields = parseFields({ fields: "id,genres.id" });

		expect(includesField(fields, "genres")).toBeTrue();
		expect(includesField(fields, "images")).toBeFalse();
	});
});
