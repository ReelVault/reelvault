import { describe, expect, test } from "bun:test";
import { parseImageRequest } from "./image-request.parser";

const CONFIG = {
	maxWidth: 1920,
	maxHeight: 1080,
	optimization: { defaultWidth: 750, defaultQuality: 85 },
};

describe("parseImageRequest", () => {
	test("snaps dimensions and quality to the nearest supported values", () => {
		expect(parseImageRequest({ width: 3840, height: 3840, quality: 85 }, CONFIG)).toEqual({ width: 1920, height: 1080, quality: 85 });
	});

	test("clamps width to the configured maximum before snapping", () => {
		const parsed = parseImageRequest({ width: 4096 }, CONFIG);

		expect(parsed.width).toBe(1920);
		expect(parsed.height).toBeNull();
	});

	test("clamps height to the configured maximum before snapping", () => {
		const parsed = parseImageRequest({ width: 1000, height: 4096 }, CONFIG);

		expect(parsed.height).toBe(1080);
	});

	test("falls back to configured defaults when the query omits values", () => {
		expect(parseImageRequest({}, CONFIG)).toEqual({ width: 750, height: null, quality: 85 });
	});

	test("snaps to the closest supported quality below and above the scale", () => {
		expect(parseImageRequest({ quality: 50 }, CONFIG).quality).toBe(45);
		expect(parseImageRequest({ quality: 95 }, CONFIG).quality).toBe(85);
		expect(parseImageRequest({ quality: 70 }, CONFIG).quality).toBe(75);
	});

	test("treats a zero height as absent", () => {
		expect(parseImageRequest({ width: 1000, height: 0 }, CONFIG).height).toBeNull();
	});
});
