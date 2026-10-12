import { describe, expect, test } from "bun:test";
import { assertFound, assertPresent, assertProfileId, assertUserId, DomainError, errorCodeOf, toErrorCode } from "./errors";

function thrownBy(run: () => void): unknown {
	try {
		run();
	} catch (error) {
		return error;
	}

	return undefined;
}

describe("assertFound", () => {
	test("does not throw when value is present", () => {
		expect(() => assertFound("hello", "String")).not.toThrow();
		expect(() => assertFound(0, "Number")).not.toThrow();
		expect(() => assertFound(false, "Boolean")).not.toThrow();
		expect(() => assertFound({}, "Object")).not.toThrow();
	});

	test("throws a not_found error with entityType and entityId when value is null or undefined", () => {
		expect(() => assertFound(null, "User", "123")).toThrow("User not found: 123");
		expect(() => assertFound(undefined, "User", "123")).toThrow("User not found: 123");
		expect(thrownBy(() => assertFound(null, "User", "123"))).toMatchObject({ category: "not_found" });
	});

	test("omits the id from the message when entityId is omitted", () => {
		expect(() => assertFound(null, "User")).toThrow("User not found");
		expect(() => assertFound(undefined, "Session")).toThrow("Session not found");
	});

	test("throws the custom error instead of the not-found error when given", () => {
		const custom = new DomainError("conflict", "taken");
		expect(thrownBy(() => assertFound(null, "User", "1", custom))).toBe(custom);
		expect(thrownBy(() => assertFound(null, "User", "1", () => new DomainError("forbidden", "no")))).toMatchObject({
			category: "forbidden",
		});
	});
});

describe("guards", () => {
	test("assertProfileId and assertUserId reject a missing id with an unauthorized error", () => {
		expect(thrownBy(() => assertProfileId(undefined))).toMatchObject({ category: "unauthorized", code: "auth.profile_required" });
		expect(thrownBy(() => assertUserId(undefined))).toMatchObject({ category: "unauthorized", code: "auth.user_required" });
		expect(() => assertProfileId("p1")).not.toThrow();
		expect(() => assertUserId("u1")).not.toThrow();
	});

	test("assertPresent treats a missing dependency as an internal error", () => {
		expect(thrownBy(() => assertPresent(null, "db missing"))).toMatchObject({ category: "internal", message: "db missing" });
		expect(() => assertPresent(0, "unused")).not.toThrow();
	});
});

describe("errorCodeOf", () => {
	test("a domain error keeps its own code", () => {
		const error = new DomainError("validation", "name is required");

		expect(errorCodeOf(error, "download.failed")).toBe(error.code);
	});

	test("any other failure gets the fallback, never its message", () => {
		expect(errorCodeOf(new Error("ffmpeg crashed at /media/secret.mkv"), "download.failed")).toBe("download.failed");
	});
});

describe("toErrorCode", () => {
	test("a stored code is returned as it is", () => {
		expect(toErrorCode("download.storage_limit", "download.failed")).toBe("download.storage_limit");
	});

	test("a raw message from an older row falls back, so no exception text is returned", () => {
		expect(toErrorCode("ffprobe failed: /media/secret.mkv", "media.probe_failed")).toBe("media.probe_failed");
	});

	test("an empty value means no error", () => {
		expect(toErrorCode(null, "download.failed")).toBeNull();
		expect(toErrorCode("", "download.failed")).toBeNull();
	});
});
