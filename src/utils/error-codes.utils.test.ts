import { describe, expect, test } from "bun:test";
import { errorCodeOf, toErrorCode } from "./error-codes.utils";
import { ValidationError } from "./errors";

describe("errorCodeOf", () => {
	test("a domain error keeps its own code", () => {
		const error = new ValidationError("name is required");

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
