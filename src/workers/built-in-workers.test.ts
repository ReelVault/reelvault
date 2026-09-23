import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { systemSettingsStore } from "@/config/system-settings.store";
import { serverRescueService } from "@/system/server-rescue.service";
import { systemResourcesService } from "@/system/system-resources.service";
import { loadBuiltInWorkers } from "./built-in-workers";

describe("built-in workers", () => {
	test("registers the required worker ids", async () => {
		const builtInWorkers = await loadBuiltInWorkers();
		const ids = builtInWorkers.map((w) => w.id);
		// Membership set instead of an exact count lock: adding a worker must not
		// require a test edit, removing/rename one must.
		expect(ids).toContain("library-scan");
		expect(ids).toContain("library-errors-check");
		expect(ids).toContain("stream-init");
		expect(ids).toContain("image-processing");
		expect(ids).toContain("image-optimization");
		expect(ids).toContain("image-optimization-all");
		expect(ids).toContain("media-file-ingest");
		expect(ids).toContain("media-file-analysis");
		expect(ids).toContain("media-file-technical-refresh");
		expect(ids).toContain("metadata-refresh");
		expect(ids).toContain("media-files-refresh-all");
		expect(ids).toContain("trickplay-generate");
		expect(ids).toContain("downloads-process");
		expect(ids).toContain("clean-up-database");
		expect(ids).toContain("clean-up-worker-history");
		expect(ids).toContain("clean-up-transcodes");
		expect(ids).toContain("clean-up-plugin-blobs");
		expect(ids).toContain("clean-up-resource-metrics");
		expect(ids).toContain("clean-up-orphan-images");
		expect(ids).toContain("clean-up-logs");
		expect(ids).toContain("media-match-audit");
		expect(ids).toContain("media-match-audit-all");
		expect(new Set(ids).size).toBe(ids.length);
	});

	test("updates worker concurrency dynamically when system settings change", async () => {
		const builtInWorkers = await loadBuiltInWorkers();
		const imageWorker = builtInWorkers.find((w) => w.id === "image-processing");
		expect(imageWorker).toBeDefined();

		systemSettingsStore.setRuntimeValue("workers.definitions.imageProcessing.concurrency", 8);
		expect(imageWorker?.concurrency).toBe(8);

		systemSettingsStore.setRuntimeValue("workers.definitions.imageProcessing.concurrency", 2);
		expect(imageWorker?.concurrency).toBe(2);

		systemSettingsStore.clearRuntimeValues();
		expect(imageWorker?.concurrency).toBe(0);
	});

	test("server rescue overrides even fixed concurrency while rescuing, except protected workers", async () => {
		const builtInWorkers = await loadBuiltInWorkers();
		const libraryScan = builtInWorkers.find((w) => w.id === "library-scan");
		const streamInit = builtInWorkers.find((w) => w.id === "stream-init");
		if (!(libraryScan && streamInit)) throw new Error("Required worker definitions not found");

		// Normal operation: fixed definition concurrency applies (raw definition)
		expect(libraryScan?.concurrency).toBe(1);

		// Registry normalization is where the rescue override hooks in. Dynamic import:
		// a static one would start module evaluation at worker-registry and hit a TDZ
		// cycle (worker-registry → resource-allocator → streaming → worker.service).
		const { WorkerRegistryService } = await import("./core/worker-registry.service");
		const registry = new WorkerRegistryService();
		registry.register(libraryScan);
		registry.register(streamInit);

		const rescueSpy = spyOn(serverRescueService, "getRescueAllocation").mockImplementation((workerId: string) =>
			workerId === "stream-init" ? undefined : { allocated: 0, throttled: true, reason: "server_rescue" },
		);

		try {
			expect(registry.get("library-scan")?.concurrency).toBe(0);
			// Stream-init concurrency is hardware-derived (see server.config getter).
			expect(registry.get("stream-init")?.concurrency).toBe(systemResourcesService.getHeavySubprocessConcurrency());
		} finally {
			rescueSpy.mockRestore();
		}

		expect(registry.get("library-scan")?.concurrency).toBe(1);
	});
});

// The settings store is process-global — never leak overrides into other test files.
afterEach(() => systemSettingsStore.clearRuntimeValues());
