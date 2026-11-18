import { describe, expect, test } from "bun:test";
import { buildImageCacheKey, getRegisteredImageIdFromCacheKey } from "./image-cache-key.utils";

const SOURCE_PATH = "/images/source.png";
const OPTIONS = { width: 1000, height: 256, quality: 85 };
const VERSION = "123-456";

describe("buildImageCacheKey", () => {
	test("builds the filename from a registered image id and the variant", () => {
		expect(buildImageCacheKey("img-42", SOURCE_PATH, OPTIONS, VERSION)).toBe("img-42_1000_256_85_123-456.webp");
	});

	test("derives a source-prefixed id from the first 16 hex digits of the source path hash", () => {
		// sha1("/images/source.png") = 7889e639c4a57a6702a71fd6a9d5a7cc6da3587e
		expect(buildImageCacheKey(undefined, SOURCE_PATH, OPTIONS, VERSION)).toBe("src_7889e639c4a57a67_1000_256_85_123-456.webp");
	});

	test("encodes a missing height as zero in the filename", () => {
		expect(buildImageCacheKey("img-42", SOURCE_PATH, { width: 640, height: null, quality: 75 }, "v2")).toBe("img-42_640_0_75_v2.webp");
	});
});

describe("getRegisteredImageIdFromCacheKey", () => {
	test("reads the registered id from a cache filename", () => {
		expect(getRegisteredImageIdFromCacheKey("img-42_1000_256_85_123-456.webp")).toBe("img-42");
	});

	test("returns null for a source-derived cache entry", () => {
		expect(getRegisteredImageIdFromCacheKey("src_7889e639c4a57a67_1000_256_85_123-456.webp")).toBeNull();
	});
});
