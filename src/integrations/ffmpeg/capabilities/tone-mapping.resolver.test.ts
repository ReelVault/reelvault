import { describe, expect, it } from "bun:test";
import { resolveToneMappingMethod } from "./tone-mapping.resolver";

// The filter sets are literals, so the suite does not depend on which ffmpeg
// build the machine has: jellyfin-ffmpeg ships `tonemapx`, upstream ffmpeg
// ships the `zscale`+`tonemap` pair, and a minimal build has neither.
describe("resolveToneMappingMethod", () => {
	it("prefers the self-contained tonemapx filter when the build has it", () => {
		expect(resolveToneMappingMethod(new Set(["scale", "tonemapx", "zscale", "tonemap"]))).toBe("tonemapx");
	});

	it("uses tonemapx alone on a build that ships no zscale pair", () => {
		expect(resolveToneMappingMethod(new Set(["scale", "tonemapx"]))).toBe("tonemapx");
	});

	it("falls back to the zscale and tonemap pair of an upstream build", () => {
		expect(resolveToneMappingMethod(new Set(["scale", "zscale", "tonemap"]))).toBe("zscale");
	});

	it("needs both filters of the zscale pair", () => {
		expect(resolveToneMappingMethod(new Set(["scale", "zscale"]))).toBe("none");
		expect(resolveToneMappingMethod(new Set(["scale", "tonemap"]))).toBe("none");
	});

	it("reports no tone mapping when the build has neither pair", () => {
		expect(resolveToneMappingMethod(new Set(["scale", "overlay"]))).toBe("none");
		expect(resolveToneMappingMethod(new Set())).toBe("none");
	});
});
