import { describe, expect, test } from "bun:test";
import { isNewerVersion, parseSemver } from "./semver.utils";

describe("parseSemver", () => {
	test("parses plain and v-prefixed versions", () => {
		expect(parseSemver("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
		expect(parseSemver("v1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
		expect(parseSemver("  v10.0.14  ")).toEqual({ major: 10, minor: 0, patch: 14 });
	});

	test("ignores prerelease suffixes", () => {
		expect(parseSemver("1.2.3-beta.1")).toEqual({ major: 1, minor: 2, patch: 3 });
	});

	test("rejects garbage", () => {
		expect(parseSemver("abc")).toBeNull();
		expect(parseSemver("1.2")).toBeNull();
		expect(parseSemver("")).toBeNull();
	});
});

describe("isNewerVersion", () => {
	test("detects newer patch, minor and major", () => {
		expect(isNewerVersion("1.0.1", "1.0.0")).toBe(true);
		expect(isNewerVersion("1.1.0", "1.0.9")).toBe(true);
		expect(isNewerVersion("2.0.0", "1.9.9")).toBe(true);
	});

	test("rejects equal and older versions", () => {
		expect(isNewerVersion("1.0.0", "1.0.0")).toBe(false);
		expect(isNewerVersion("1.0.0", "1.0.1")).toBe(false);
		expect(isNewerVersion("0.9.9", "1.0.0")).toBe(false);
	});

	test("tolerates a v prefix on either side", () => {
		expect(isNewerVersion("v1.1.0", "1.0.0")).toBe(true);
		expect(isNewerVersion("1.1.0", "v1.1.0")).toBe(false);
	});

	test("unparseable versions never count as upgrades", () => {
		expect(isNewerVersion("latest", "1.0.0")).toBe(false);
		expect(isNewerVersion("1.2.3", "")).toBe(false);
	});
});
