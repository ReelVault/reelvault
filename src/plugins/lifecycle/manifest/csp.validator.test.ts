import { describe, expect, test } from "bun:test";
import { validatePluginCsp } from "./csp.validator";

function acceptedCsp(value: unknown): string {
	validatePluginCsp(value);

	return "accepted";
}

function invalidCsp(value: unknown): unknown {
	try {
		validatePluginCsp(value);
	} catch (error) {
		return error;
	}

	return "accepted";
}

describe("validatePluginCsp", () => {
	test("accepts plain origins, wildcard subdomains and ports", () => {
		expect(
			acceptedCsp({
				"img-src": ["https://cdn.example.com", "https://*.example.com:8443"],
				"media-src": ["http://media.lan:8080"],
			}),
		).toBe("accepted");
	});

	test("rejects null as the csp value", () => {
		expect(invalidCsp(null)).toMatchObject({ category: "validation", code: "plugin.field_not_object", params: { field: "csp" } });
	});

	test("rejects an array as the csp value", () => {
		expect(invalidCsp([])).toMatchObject({ category: "validation", code: "plugin.field_not_object", params: { field: "csp" } });
	});

	test("rejects a string as the csp value", () => {
		expect(invalidCsp("https://cdn.example.com")).toMatchObject({
			category: "validation",
			code: "plugin.field_not_object",
			params: { field: "csp" },
		});
	});

	test("rejects a number as the csp value", () => {
		expect(invalidCsp(42)).toMatchObject({ category: "validation", code: "plugin.field_not_object", params: { field: "csp" } });
	});

	test("rejects a directive outside the allowlist", () => {
		expect(invalidCsp({ "script-src": ["https://cdn.example.com"] })).toMatchObject({
			category: "validation",
			code: "plugin.csp_directive_unsupported",
			params: { directive: "script-src" },
		});
	});

	test("rejects an empty source list", () => {
		expect(invalidCsp({ "img-src": [] })).toMatchObject({
			category: "validation",
			code: "plugin.field_empty",
			params: { field: "csp.img-src" },
		});
	});

	test("rejects a string source list", () => {
		expect(invalidCsp({ "img-src": "https://cdn.example.com" })).toMatchObject({
			category: "validation",
			code: "plugin.field_empty",
			params: { field: "csp.img-src" },
		});
	});

	test("rejects a numeric source list", () => {
		expect(invalidCsp({ "img-src": 42 })).toMatchObject({
			category: "validation",
			code: "plugin.field_empty",
			params: { field: "csp.img-src" },
		});
	});

	test.each([
		"https://cdn.example.com/path",
		"xhttps://cdn.example.com",
		"ftp://cdn.example.com",
		"*.example.com",
		"https://bad host",
		"",
		42,
	])("rejects an invalid source: %p", (source) => {
		expect(invalidCsp({ "img-src": [source] })).toMatchObject({
			category: "validation",
			code: "plugin.csp_source_invalid",
			params: { directive: "img-src", source: String(source) },
		});
	});

	test("accepts the maximum number of sources across directives", () => {
		const first = Array.from({ length: 25 }, (_value, index) => `https://a${index}.example.com`);
		const second = Array.from({ length: 25 }, (_value, index) => `https://b${index}.example.com`);

		expect(acceptedCsp({ "img-src": first, "media-src": second })).toBe("accepted");
	});

	test("rejects more than the maximum number of sources across directives", () => {
		const sources = Array.from({ length: 51 }, (_value, index) => `https://cdn${index}.example.com`);

		expect(invalidCsp({ "img-src": sources })).toMatchObject({
			category: "validation",
			code: "plugin.csp_too_many_sources",
			params: { max: 50 },
		});
	});

	test("counts sources across directives toward the cap", () => {
		const first = Array.from({ length: 26 }, (_value, index) => `https://a${index}.example.com`);
		const second = Array.from({ length: 25 }, (_value, index) => `https://b${index}.example.com`);

		expect(invalidCsp({ "img-src": first, "media-src": second })).toMatchObject({
			category: "validation",
			code: "plugin.csp_too_many_sources",
			params: { max: 50 },
		});
	});
});
