import { describe, expect, test } from "bun:test";
import { isNewerVersion, parseSemver } from "./semver.utils";

describe("parseSemver", () => {
	test("parses plain and v-prefixed versions", () => {
		expect(parseSemver("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: null });
		expect(parseSemver("v1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: null });
		expect(parseSemver("  v10.0.14  ")).toEqual({ major: 10, minor: 0, patch: 14, prerelease: null });
	});

	test("captures prerelease identifiers and ignores build metadata", () => {
		expect(parseSemver("1.2.3-beta.1")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: "beta.1" });
		expect(parseSemver("2.0.0-rc.1+build.5")).toEqual({ major: 2, minor: 0, patch: 0, prerelease: "rc.1" });
		expect(parseSemver("1.2.3+build.5")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: null });
	});

	test("rejects garbage", () => {
		expect(parseSemver("abc")).toBeNull();
		expect(parseSemver("1.2")).toBeNull();
		expect(parseSemver("")).toBeNull();
		expect(parseSemver("1.2.3.4")).toBeNull();
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

	test("a prerelease never outranks its release", () => {
		expect(isNewerVersion("2.0.0-rc.1", "1.9.0")).toBe(true);
		expect(isNewerVersion("2.0.0", "2.0.0-rc.1")).toBe(true);
		expect(isNewerVersion("2.0.0-rc.1", "2.0.0")).toBe(false);
		expect(isNewerVersion("1.2.4-beta", "1.2.4")).toBe(false);
		expect(isNewerVersion("1.2.4", "1.2.4-beta")).toBe(true);
	});

	test("orders prerelease identifiers per semver precedence", () => {
		expect(isNewerVersion("2.0.0-rc.2", "2.0.0-rc.1")).toBe(true);
		expect(isNewerVersion("2.0.0-rc.1", "2.0.0-rc.2")).toBe(false);
		expect(isNewerVersion("2.0.0-rc.1", "2.0.0-beta.9")).toBe(true);
		expect(isNewerVersion("1.0.0-alpha", "1.0.0-alpha.1")).toBe(false);
		expect(isNewerVersion("1.0.0-alpha.1", "1.0.0-alpha")).toBe(true);
	});

	test("unparseable versions never count as upgrades", () => {
		expect(isNewerVersion("latest", "1.0.0")).toBe(false);
		expect(isNewerVersion("1.2.3", "")).toBe(false);
		expect(isNewerVersion("1.2.3.4", "1.2.3")).toBe(false);
	});
});
