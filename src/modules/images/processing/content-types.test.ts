import { describe, expect, test } from "bun:test";
import { DomainError } from "@/utils/errors";
import { getContentType } from "./content-types";

/** The category of the error `run` throws, or undefined when it does not throw. */
function categoryOf(run: () => unknown): string | undefined {
	try {
		run();
	} catch (error) {
		return error instanceof DomainError ? error.category : undefined;
	}

	return undefined;
}

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
		expect(categoryOf(() => getContentType("exe"))).toBe("validation");
		expect(() => getContentType("exe")).toThrow("Unsupported image format: exe");
		expect(categoryOf(() => getContentType(""))).toBe("validation");
	});
});
