import { describe, expect, test } from "bun:test";
import { ValidationError } from "@/utils/errors";
import { getContentType } from "./content-types";

describe("getContentType", () => {
	test("maps sharp format names to mime types", () => {
		expect(getContentType("webp")).toBe("image/webp");
		expect(getContentType("jpeg")).toBe("image/jpeg");
		expect(getContentType("jpg")).toBe("image/jpeg");
		expect(getContentType("png")).toBe("image/png");
		expect(getContentType("avif")).toBe("image/avif");
		expect(getContentType("gif")).toBe("image/gif");
		expect(getContentType("heif")).toBe("image/heif");
		expect(getContentType("bmp")).toBe("image/bmp");
		expect(getContentType("tiff")).toBe("image/tiff");
		expect(getContentType("svg")).toBe("image/svg+xml");
	});

	test("is case-insensitive", () => {
		expect(getContentType("PNG")).toBe("image/png");
		expect(getContentType("WebP")).toBe("image/webp");
	});

	test("rejects unknown formats", () => {
		expect(() => getContentType("exe")).toThrow(ValidationError);
		expect(() => getContentType("exe")).toThrow("Unsupported image format: exe");
		expect(() => getContentType("")).toThrow(ValidationError);
	});
});
