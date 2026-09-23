import { describe, expect, test } from "bun:test";
import { sidecarMetadataWriter } from "./sidecar-metadata-writer.runtime";

describe("sidecarMetadataWriter", () => {
	test("exposes the full write surface backed by the reelvault adapter", () => {
		expect(typeof sidecarMetadataWriter.saveMovie).toBe("function");
		expect(typeof sidecarMetadataWriter.saveSeries).toBe("function");
		expect(typeof sidecarMetadataWriter.saveSeason).toBe("function");
		expect(typeof sidecarMetadataWriter.saveEpisode).toBe("function");
	});
});
