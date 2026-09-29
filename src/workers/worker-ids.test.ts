import { describe, expect, test } from "bun:test";
import { loadBuiltInWorkers } from "./built-in-workers";
import { canonicalWorkerId, UNCATEGORIZED_WORKER_IDS } from "./worker-ids";

describe("worker id categories", () => {
	test("every registered worker id is categorized or explicitly uncategorized", async () => {
		const workers = await loadBuiltInWorkers();
		const registeredIds = workers.map((worker) => worker.id);

		for (const id of registeredIds) {
			const categorized = canonicalWorkerId(id) !== undefined;
			const explicitlyUncategorized = UNCATEGORIZED_WORKER_IDS.has(id);

			expect({ id, covered: categorized || explicitlyUncategorized }).toEqual({ id, covered: true });
		}
	});

	test("the uncategorized set contains no orphaned ids", async () => {
		const workers = await loadBuiltInWorkers();
		const registeredIds = new Set(workers.map((worker) => worker.id));

		for (const id of UNCATEGORIZED_WORKER_IDS) {
			expect(registeredIds.has(id)).toBe(true);
		}
	});

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
