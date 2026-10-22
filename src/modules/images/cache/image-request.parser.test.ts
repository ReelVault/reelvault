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

	test("caps a requested width at the configured maximum", () => {
		// 1920 is the largest supported width, so a maximum of 1200 is what shows the cap at work.
		const parsed = parseImageRequest({ width: 4096 }, { ...CONFIG, maxWidth: 1200 });

		expect(parsed.width).toBe(1200);
		expect(parsed.height).toBeNull();
	});

	test("caps a requested height at the configured maximum", () => {
		const parsed = parseImageRequest({ width: 1000, height: 4096 }, CONFIG);

		expect(parsed.height).toBe(1080);
	});

	test("snaps a width between two supported widths to the closer one", () => {
		expect(parseImageRequest({ width: 900 }, CONFIG).width).toBe(828);
	});

	test("falls back to configured defaults when the query omits values", () => {
		expect(parseImageRequest({}, CONFIG)).toEqual({ width: 750, height: null, quality: 85 });
	});

	test("snaps a requested quality to the nearest supported step", () => {
		expect(parseImageRequest({ quality: 50 }, CONFIG).quality).toBe(45);
		expect(parseImageRequest({ quality: 95 }, CONFIG).quality).toBe(85);
		expect(parseImageRequest({ quality: 70 }, CONFIG).quality).toBe(75);
	});

	test("treats a zero height as absent", () => {
		expect(parseImageRequest({ width: 1000, height: 0 }, CONFIG).height).toBeNull();
	});
});
