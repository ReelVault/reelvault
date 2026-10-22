import { describe, expect, test } from "bun:test";
import { SERVER_VERSION } from "@/config/version.constants";
import { isNewerVersion, minServerVersionError, requiresNewerServer } from "./semver.utils";

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

	test("unparseable versions never count as upgrades", () => {
		expect(isNewerVersion("latest", "1.0.0")).toBe(false);
		expect(isNewerVersion("1.2.3", "")).toBe(false);
		expect(isNewerVersion("1.2.3.4", "1.2.3")).toBe(false);
		// Bun's semver parser accepts a two-segment version; update tags must not.
		expect(isNewerVersion("1.2", "1.1.0")).toBe(false);
		expect(isNewerVersion("v1.2", "1.1.0")).toBe(false);
	});
});

describe("minServerVersionError", () => {
	test("refuses a floor newer than the running server with the caller's code", () => {
		const error = minServerVersionError("999.0.0", "Plugin demo 1.0.0", "plugin.server_too_old");

		expect(error).toMatchObject({ category: "validation", code: "plugin.server_too_old" });
		expect(requiresNewerServer("999.0.0")).toBeTrue();
	});

	test("accepts the running version, a missing floor and an unparseable floor", () => {
		expect(minServerVersionError(SERVER_VERSION, "Plugin demo 1.0.0", "plugin.server_too_old")).toBeUndefined();
		expect(minServerVersionError(undefined, "Plugin demo 1.0.0", "plugin.server_too_old")).toBeUndefined();
		expect(minServerVersionError(null, "Plugin demo 1.0.0", "plugin.server_too_old")).toBeUndefined();
		expect(minServerVersionError("latest", "Plugin demo 1.0.0", "plugin.server_too_old")).toBeUndefined();
		expect(requiresNewerServer("latest")).toBeFalse();
	});
});
