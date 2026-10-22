import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { MediaAnalyzer } from "@reelvault/sdk/plugin";
import { MediaAnalysisFanout } from "./media-analysis.fanout";

function createAnalyzer(id: string, analyze: MediaAnalyzer["analyze"]): MediaAnalyzer {
	return { id, name: id.toUpperCase(), version: "1.0.0", analyze };
}

const media = { id: "file-1", metadataId: "metadata-1", fileName: "movie.mkv", available: true };

describe("MediaAnalysisFanout", () => {
	let fanout: MediaAnalysisFanout;

	beforeEach(() => {
		fanout = new MediaAnalysisFanout();
	});

	afterEach(() => fanout.clear());

	test("assertRegisterable names the plugin that owns a duplicate analyzer", () => {
		fanout.register("owner", [createAnalyzer("dup", () => ({}))]);

		expect(() => fanout.assertRegisterable([createAnalyzer("dup", () => ({}))])).toThrow(
			expect.objectContaining({ category: "validation", code: "plugin.entity_conflict", params: { id: "dup", plugin: "owner" } }),
		);
		fanout.assertRegisterable([createAnalyzer("fresh", () => ({}))]);
	});

	test("removeForPlugin frees ids so another plugin can register them", () => {
		fanout.register("plugin-a", [createAnalyzer("shared", () => ({}))]);
		fanout.removeForPlugin("plugin-a");
		fanout.register("plugin-b", [createAnalyzer("shared", () => ({}))]);

		expect(() => fanout.assertRegisterable([createAnalyzer("shared", () => ({}))])).toThrow(
			expect.objectContaining({
				category: "validation",
				code: "plugin.entity_conflict",
				params: { id: "shared", plugin: "plugin-b" },
			}),
		);
	});

	test("merges the fields of every analyzer and keeps the others when one throws", async () => {
		fanout.register("p", [
			createAnalyzer("a-source", () => ({ source: "WEB-DL" })),
			createAnalyzer("broken", () => {
				throw new Error("analysis failed");
			}),
			createAnalyzer("z-quality", () => ({ qualityTag: "2160p" })),
		]);

		await expect(fanout.analyze(media)).resolves.toEqual({ source: "WEB-DL", qualityTag: "2160p" });
	});

	test("a later analyzer's value wins over an earlier one for the same field", async () => {
		fanout.register("p", [createAnalyzer("first", () => ({ source: "WEB-DL" })), createAnalyzer("second", () => ({ source: "BluRay" }))]);

		await expect(fanout.analyze(media)).resolves.toEqual({ source: "BluRay" });
	});

	test("trims values and turns whitespace-only values into null", async () => {
		fanout.register("p", [createAnalyzer("trims", () => ({ source: "  WEB-DL  ", edition: "   " }))]);

		await expect(fanout.analyze(media)).resolves.toEqual({ source: "WEB-DL", edition: null });
	});

	test("an undefined field does not overwrite a value an earlier analyzer set", async () => {
		fanout.register("p", [
			createAnalyzer("probe", () => ({ qualityTag: "2160p" })),
			createAnalyzer("sparse", () => ({ qualityTag: undefined, source: "BluRay" })),
		]);

		await expect(fanout.analyze(media)).resolves.toEqual({ qualityTag: "2160p", source: "BluRay" });
	});
});
