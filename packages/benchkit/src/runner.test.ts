import { describe, expect, test } from "bun:test";
import { compileOnlyFilter } from "./runner";

describe("compileOnlyFilter", () => {
	test("returns undefined without a pattern", () => {
		expect(compileOnlyFilter(undefined)).toBeUndefined();
		expect(compileOnlyFilter("")).toBeUndefined();
	});

	test("matches unit names case-insensitively", () => {
		const re = compileOnlyFilter("mark-read");
		expect(re?.test("write: mark-read burst")).toBe(true);
		expect(re?.test("write: endpoints")).toBe(false);
	});

	test("rejects invalid regex patterns", () => {
		expect(() => compileOnlyFilter("(")).toThrow();
	});
});
