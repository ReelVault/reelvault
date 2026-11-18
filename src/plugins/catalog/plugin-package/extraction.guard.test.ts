import { describe, expect, test } from "bun:test";
import { assertSafeDestination, conflictingEntry, invalidSymlink } from "./extraction.guard";

describe("extraction guard error params", () => {
	test("names the offending path in an unsafe-path error", () => {
		expect(() => assertSafeDestination("/work/root", "../escape.txt")).toThrow(
			expect.objectContaining({
				category: "validation",
				code: "plugin.package_path_unsafe",
				params: { path: "../escape.txt" },
			}),
		);
	});

	test("names the conflicting path in a conflicting-entry error", () => {
		expect(conflictingEntry("plugin/lnk")).toMatchObject({
			category: "validation",
			code: "plugin.package_path_conflict",
			params: { path: "plugin/lnk" },
		});
	});

	test("names the symlink in an invalid-symlink error", () => {
		expect(invalidSymlink("plugin/link.mjs", "an absolute symlink")).toMatchObject({
			category: "validation",
			code: "plugin.package_symlink_invalid",
			params: { path: "plugin/link.mjs" },
		});
	});
});
