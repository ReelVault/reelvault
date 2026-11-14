import { describe, expect, test } from "bun:test";
import type { FrameExtractionRequest, SpriteExtractionRequest } from "@reelvault/sdk/plugin";
import { serverConfig } from "@/config/server/server.config";
import { assertFrameExtractionRequest, assertSpriteExtractionRequest, contentTypeFor } from "./request-validation.guard";

const limits = serverConfig.plugins.ffmpeg;
const INVALID = { category: "validation", code: "plugin.ffmpeg.invalid_request" } as const;

function frameRequest(overrides: Partial<FrameExtractionRequest> = {}): FrameExtractionRequest {
	return { mediaFileId: "media-1", timeMs: 0, ...overrides };
}

function spriteRequest(overrides: Partial<SpriteExtractionRequest> = {}): SpriteExtractionRequest {
	return {
		mediaFileId: "media-1",
		timeMs: [0, 100],
		width: limits.minFrameDimension,
		height: limits.minFrameDimension,
		columns: 1,
		...overrides,
	};
}

function acceptedFrame(request: FrameExtractionRequest): string {
	assertFrameExtractionRequest(request);

	return "accepted";
}

function acceptedSprite(request: SpriteExtractionRequest): string {
	assertSpriteExtractionRequest(request);

	return "accepted";
}

describe("assertFrameExtractionRequest", () => {
	test("accepts a minimal frame request", () => {
		expect(acceptedFrame(frameRequest())).toBe("accepted");
	});

	test("accepts the smallest and largest frame widths", () => {
		expect(acceptedFrame(frameRequest({ width: limits.minFrameDimension }))).toBe("accepted");
		expect(acceptedFrame(frameRequest({ width: limits.maxFrameDimension }))).toBe("accepted");
	});

	test("accepts a request without an explicit width", () => {
		expect(acceptedFrame(frameRequest({ width: undefined }))).toBe("accepted");
	});

	test("rejects an empty media file id", () => {
		expect(() => assertFrameExtractionRequest(frameRequest({ mediaFileId: "" }))).toThrow(expect.objectContaining(INVALID));
	});

	test.each([-1, -0.1, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid timeMs %p", (timeMs) => {
		expect(() => assertFrameExtractionRequest(frameRequest({ timeMs }))).toThrow(expect.objectContaining(INVALID));
	});

	test.each([0, 1.5, limits.minFrameDimension - 1, limits.maxFrameDimension + 1])("rejects invalid width %p", (width) => {
		expect(() => assertFrameExtractionRequest(frameRequest({ width }))).toThrow(expect.objectContaining(INVALID));
	});
});

describe("assertSpriteExtractionRequest", () => {
	test("accepts a minimal sprite request", () => {
		expect(acceptedSprite(spriteRequest())).toBe("accepted");
	});

	test("accepts the maximum frame count at the smallest dimensions", () => {
		const timeMs = Array.from({ length: limits.maxSpriteFrames }, (_value, index) => index * 100);

		expect(acceptedSprite(spriteRequest({ timeMs, columns: 1 }))).toBe("accepted");
	});

	test("accepts the largest allowed sprite frame dimensions", () => {
		expect(
			acceptedSprite(
				spriteRequest({
					timeMs: [0],
					width: limits.maxSpriteWidth,
					height: limits.maxSpriteHeight,
					columns: 1,
				}),
			),
		).toBe("accepted");
	});

	test("accepts one column per frame", () => {
		const timeMs = [0, 100, 200];

		expect(acceptedSprite(spriteRequest({ timeMs, columns: timeMs.length }))).toBe("accepted");
	});

	test("rejects an empty media file id", () => {
		expect(() => assertSpriteExtractionRequest(spriteRequest({ mediaFileId: "" }))).toThrow(expect.objectContaining(INVALID));
	});

	test("rejects an empty timeMs array", () => {
		expect(() => assertSpriteExtractionRequest(spriteRequest({ timeMs: [] }))).toThrow(expect.objectContaining(INVALID));
	});

	test("rejects a non-array timeMs value", () => {
		const request = { ...spriteRequest(), timeMs: 100 } as unknown as SpriteExtractionRequest;

		expect(() => assertSpriteExtractionRequest(request)).toThrow(expect.objectContaining(INVALID));
	});

	test("rejects more frames than the sprite limit", () => {
		const timeMs = Array.from({ length: limits.maxSpriteFrames + 1 }, (_value, index) => index * 100);

		expect(() => assertSpriteExtractionRequest(spriteRequest({ timeMs, columns: 1 }))).toThrow(expect.objectContaining(INVALID));
	});

	test.each([-1, Number.NaN, Number.POSITIVE_INFINITY])("rejects an invalid timeMs value %p", (timeMs) => {
		expect(() => assertSpriteExtractionRequest(spriteRequest({ timeMs: [0, timeMs] }))).toThrow(expect.objectContaining(INVALID));
	});

	test.each([limits.minFrameDimension - 1, limits.maxSpriteWidth + 1, 64.5])("rejects invalid sprite width %p", (width) => {
		expect(() => assertSpriteExtractionRequest(spriteRequest({ width }))).toThrow(expect.objectContaining(INVALID));
	});

	test.each([limits.minFrameDimension - 1, limits.maxSpriteHeight + 1, 64.5])("rejects invalid sprite height %p", (height) => {
		expect(() => assertSpriteExtractionRequest(spriteRequest({ height }))).toThrow(expect.objectContaining(INVALID));
	});

	test.each([0, -1, 1.5, 3])("rejects columns %p outside 1..timeMs.length", (columns) => {
		expect(() => assertSpriteExtractionRequest(spriteRequest({ timeMs: [0, 100], columns }))).toThrow(expect.objectContaining(INVALID));
	});

	test("rejects a sprite whose total pixel count exceeds the limit", () => {
		const timeMs = Array.from({ length: 8 }, (_value, index) => index * 100);

		expect(() =>
			assertSpriteExtractionRequest(
				spriteRequest({
					timeMs,
					width: limits.maxSpriteWidth,
					height: limits.maxSpriteHeight,
					columns: 1,
				}),
			),
		).toThrow(expect.objectContaining(INVALID));
	});

	test("rejects a multi-column sprite once the rounded row count exceeds the pixel limit", () => {
		const timeMs = [0, 100, 200, 300, 400];

		expect(() =>
			assertSpriteExtractionRequest(
				spriteRequest({
					timeMs,
					width: limits.maxSpriteWidth,
					height: limits.maxSpriteHeight,
					columns: 4,
				}),
			),
		).toThrow(expect.objectContaining(INVALID));
	});

	test("accepts a sprite exactly at the pixel limit", () => {
		const timeMs = Array.from({ length: 16 }, (_value, index) => index * 100);

		expect(
			acceptedSprite(
				spriteRequest({
					timeMs,
					width: 1000,
					height: 1000,
					columns: 16,
				}),
			),
		).toBe("accepted");
	});
});

describe("contentTypeFor", () => {
	test("maps webp frames to the webp content type", () => {
		expect(contentTypeFor("webp")).toBe("image/webp");
	});

	test("maps jpeg frames to the jpeg content type", () => {
		expect(contentTypeFor("jpeg")).toBe("image/jpeg");
	});
});
