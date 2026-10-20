import { describe, expect, test } from "bun:test";
import {
	assertExists,
	assertFound,
	assertPresent,
	assertProfileId,
	assertUserId,
	DomainError,
	errorCodeOf,
	toErrorCode,
} from "./domain.errors";

function thrownBy(run: () => void): unknown {
	try {
		run();
	} catch (error) {
		return error;
	}

	return undefined;
}

describe("assertFound", () => {
	test("throws a not_found error with entityType and entityId when value is null or undefined", () => {
		const withId = { category: "not_found", code: "entity.not_found", params: { entityType: "User", entityId: "123" } };
		expect(() => assertFound(null, "User", "123")).toThrow(expect.objectContaining(withId));
		expect(() => assertFound(undefined, "User", "123")).toThrow(expect.objectContaining(withId));
		expect(thrownBy(() => assertFound(null, "User", "123"))).toMatchObject({ category: "not_found" });
	});

	test("reports a not_found entity error when no id is given", () => {
		expect(() => assertFound(null, "User")).toThrow(expect.objectContaining({ category: "not_found", code: "entity.not_found" }));
		expect(() => assertFound(undefined, "Session")).toThrow(expect.objectContaining({ category: "not_found", code: "entity.not_found" }));
	});

	test("throws the custom error instead of the not-found error when given", () => {
		const custom = new DomainError("conflict", "taken");
		expect(thrownBy(() => assertFound(null, "User", "1", custom))).toBe(custom);
		expect(thrownBy(() => assertFound(null, "User", "1", () => new DomainError("forbidden", "no")))).toMatchObject({
			category: "forbidden",
		});
	});
});

describe("assertExists", () => {
	test("passes a true existence result and throws not_found for false", () => {
		expect(assertExists(true, "Library", "library-1")).toBeUndefined();
		expect(() => assertExists(false, "Library", "library-1")).toThrow(
			expect.objectContaining({
				category: "not_found",
				code: "entity.not_found",
				params: { entityType: "Library", entityId: "library-1" },
			}),
		);
	});

	test("throws the custom error instead of the not-found error when given", () => {
		const custom = new DomainError("conflict", "in use");
		expect(thrownBy(() => assertExists(false, "Library", "1", custom))).toBe(custom);
	});
});

describe("guards", () => {
	test("assertProfileId and assertUserId reject a missing id with an unauthorized error", () => {
		expect(thrownBy(() => assertProfileId(undefined))).toMatchObject({ category: "unauthorized", code: "auth.profile_required" });
		expect(thrownBy(() => assertUserId(undefined))).toMatchObject({ category: "unauthorized", code: "auth.user_required" });
	});

	test("assertPresent treats a missing dependency as an internal error", () => {
		expect(thrownBy(() => assertPresent(null, "db missing"))).toMatchObject({ category: "internal" });
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
