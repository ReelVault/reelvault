import { describe, expect, test } from "bun:test";
import { canonicalWorkerId } from "./worker-ids.utils";

describe("worker id categories", () => {
	test("every resource category resolves from at least one spelling", () => {
		expect(canonicalWorkerId("image-optimization-all")).toBe("image-processing");
		expect(canonicalWorkerId("imageProcessing")).toBe("image-processing");
		expect(canonicalWorkerId("library-scan")).toBe("scanning");
		expect(canonicalWorkerId("scanning")).toBe("scanning");
		expect(canonicalWorkerId("transcode")).toBe("transcode");
		expect(canonicalWorkerId("metadata-refresh")).toBe("metadata-refresh");
		expect(canonicalWorkerId("mediaFileAnalysis")).toBe("media-file-analysis");
		expect(canonicalWorkerId("media-file-technical-refresh")).toBe("media-file-technical-refresh");
	});

	test("uncategorized workers have no resource category", () => {
		expect(canonicalWorkerId("media-file-ingest")).toBeUndefined();
		expect(canonicalWorkerId("clean-up-database")).toBeUndefined();
		expect(canonicalWorkerId("stream-init")).toBeUndefined();
	});
});
