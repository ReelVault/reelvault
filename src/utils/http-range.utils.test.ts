import { describe, expect, test } from "bun:test";
import { byteRangeResponse, contentRangeFor, parseByteRange } from "./http-range.utils";

describe("parseByteRange", () => {
	test("returns undefined when there is no header", () => {
		expect(parseByteRange(null, 100)).toBeUndefined();
		expect(parseByteRange("", 100)).toBeUndefined();
	});

	test("returns undefined for multi-range and non-bytes units (serve in full)", () => {
		expect(parseByteRange("bytes=0-1,5-9", 100)).toBeUndefined();
		expect(parseByteRange("items=0-9", 100)).toBeUndefined();
	});

	test("parses start-end, open-ended and suffix forms", () => {
		expect(parseByteRange("bytes=10-19", 100)).toEqual({ start: 10, end: 19 });
		expect(parseByteRange("bytes=10-", 100)).toEqual({ start: 10, end: 99 });
		expect(parseByteRange("bytes=-7", 100)).toEqual({ start: 93, end: 99 });
		expect(parseByteRange("bytes=-999", 100)).toEqual({ start: 0, end: 99 });
	});

	test("clamps the end to the last byte", () => {
		expect(parseByteRange("bytes=90-500", 100)).toEqual({ start: 90, end: 99 });
	});

	test("marks unsatisfiable and malformed values as invalid", () => {
		expect(parseByteRange("bytes=100-", 100)).toBe("invalid");
		expect(parseByteRange("bytes=50-49", 100)).toBe("invalid");
		expect(parseByteRange("bytes=-0", 100)).toBe("invalid");
	});

	test("returns undefined for an empty resource", () => {
		expect(parseByteRange("bytes=0-", 0)).toBeUndefined();
	});
});

describe("contentRangeFor", () => {
	test("formats the inclusive range with the total size", () => {
		expect(contentRangeFor({ start: 12, end: 23 }, 640)).toBe("bytes 12-23/640");
	});
});

describe("byteRangeResponse", () => {
	const blob = new Blob(["0123456789"]);
	const baseHeaders = { "Content-Type": "video/mp4" };

	test("returns undefined when the request has no range (serve in full)", () => {
		expect(byteRangeResponse(blob, null, baseHeaders)).toBeUndefined();
	});

	test("builds a 206 with the sliced body and Content-Range", async () => {
		const response = byteRangeResponse(blob, "bytes=2-4", baseHeaders);
		expect(response?.status).toBe(206);
		expect(response?.headers.get("Content-Range")).toBe("bytes 2-4/10");
		expect(await response?.text()).toBe("234");
	});

	test("builds a 416 for an unsatisfiable range", () => {
		const response = byteRangeResponse(blob, "bytes=99-", baseHeaders);
		expect(response?.status).toBe(416);
		expect(response?.headers.get("Content-Range")).toBe("bytes */10");
	});

	test("keeps the caller's base headers on the response", () => {
		const response = byteRangeResponse(blob, "bytes=0-0", baseHeaders);
		expect(response?.headers.get("Content-Type")).toBe("video/mp4");
	});
});
