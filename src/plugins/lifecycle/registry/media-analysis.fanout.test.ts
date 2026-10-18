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
			expect.objectContaining({ category: "validation", code: "plugin.entity_conflict" }),
		);
	});

	test("merges analyzer output in registration order and isolates failures", async () => {
		fanout.register("p", [
			createAnalyzer("a-source", () => ({ source: "WEB-DL" })),
			createAnalyzer("broken", () => {
				throw new Error("analysis failed");
			}),
			createAnalyzer("z-quality", () => ({ qualityTag: "2160p" })),
		]);

		await expect(fanout.analyze(media)).resolves.toEqual({ source: "WEB-DL", qualityTag: "2160p" });
	});

	test("normalizes whitespace-only values to null and drops undefined fields", async () => {
		fanout.register("p", [createAnalyzer("trims", () => ({ source: "  WEB-DL  ", edition: "   ", qualityTag: undefined }))]);

		await expect(fanout.analyze(media)).resolves.toEqual({ source: "WEB-DL", edition: null });
	});
});
