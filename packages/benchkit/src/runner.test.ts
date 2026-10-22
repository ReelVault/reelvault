import { describe, expect, test } from "bun:test";
import { compileOnlyFilter, type SuiteFile, selectSuites } from "./bench.runner";

describe("compileOnlyFilter", () => {
	test("returns undefined without a pattern", () => {
		expect(compileOnlyFilter(undefined)).toBeUndefined();
		expect(compileOnlyFilter("")).toBeUndefined();
	});

	test("matches unit names case-insensitively", () => {
		const re = compileOnlyFilter("MARK-READ");
		expect(re?.test("write: mark-read burst")).toBe(true);
		expect(re?.test("write: endpoints")).toBe(false);
	});

	test("rejects invalid regex patterns", () => {
		expect(() => compileOnlyFilter("(")).toThrow(SyntaxError);
	});
});

describe("selectSuites", () => {
	const suites: SuiteFile[] = ["auth", "database", "http"].map((stem) => ({ stem, path: `/bench/${stem}.bench.ts`, description: "" }));

	test("runs the named suites in the order given, each once", () => {
		const { selected, unknown } = selectSuites(suites, ["http", "auth", "http"]);

		expect(selected.map((suite) => suite.stem)).toEqual(["http", "auth"]);
		expect(unknown).toEqual([]);
	});

	test("expands all to every suite and reports the names it does not know", () => {
		const { selected, unknown } = selectSuites(suites, ["all", "nope"]);

		expect(selected.map((suite) => suite.stem)).toEqual(["auth", "database", "http"]);
		expect(unknown).toEqual(["nope"]);
	});
});
