import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { systemSettingsStore } from "@/config/system-settings.store";
import { canonicalWorkerId, UNCATEGORIZED_WORKER_IDS } from "@/config/worker-ids.utils";
import { serverRescueService } from "@/system/server-rescue.service";
import { loadBuiltInWorkers } from "./built-in.loader";

describe("built-in workers", () => {
	test("gives every built-in worker a unique id", async () => {
		const builtInWorkers = await loadBuiltInWorkers();
		const ids = builtInWorkers.map((w) => w.id);

		expect(new Set(ids).size).toBe(ids.length);
	});

	test("every registered worker id is categorized or explicitly uncategorized", async () => {
		const builtInWorkers = await loadBuiltInWorkers();
		const registeredIds = builtInWorkers.map((worker) => worker.id);

		for (const id of registeredIds) {
			const categorized = canonicalWorkerId(id) !== undefined;
			const explicitlyUncategorized = UNCATEGORIZED_WORKER_IDS.has(id);

			expect({ id, covered: categorized || explicitlyUncategorized }).toEqual({ id, covered: true });
		}
	});

	test("the uncategorized set contains no orphaned ids", async () => {
		const builtInWorkers = await loadBuiltInWorkers();
		const registeredIds = new Set(builtInWorkers.map((worker) => worker.id));

		for (const id of UNCATEGORIZED_WORKER_IDS) {
			expect(registeredIds.has(id)).toBe(true);
		}
	});

	test("updates worker concurrency dynamically when system settings change", async () => {
		const builtInWorkers = await loadBuiltInWorkers();
		const imageWorker = builtInWorkers.find((w) => w.id === "image-processing");
		if (!imageWorker) throw new Error("Required worker definition not found");

		systemSettingsStore.setRuntimeValue("workers.definitions.imageProcessing.concurrency", 8);
		expect(imageWorker.concurrency).toBe(8);

		systemSettingsStore.setRuntimeValue("workers.definitions.imageProcessing.concurrency", 2);
		expect(imageWorker.concurrency).toBe(2);

		systemSettingsStore.clearRuntimeValues();
		expect(imageWorker.concurrency).toBe(0);
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
		// Read before the rescue is simulated: the protected worker keeps this value while rescue throttles the others.
		const protectedConcurrency = registry.get("stream-init")?.concurrency;

		const rescueSpy = spyOn(serverRescueService, "getRescueAllocation").mockImplementation((workerId: string) =>
			workerId === "stream-init" ? undefined : { allocated: 0, throttled: true, reason: "server_rescue" },
		);

		try {
			expect(registry.get("library-scan")?.concurrency).toBe(0);
			// Protected from rescue: its hardware-derived concurrency is never throttled to zero.
			expect(registry.get("stream-init")?.concurrency).toBe(protectedConcurrency);
		} finally {
			rescueSpy.mockRestore();
		}

		expect(registry.get("library-scan")?.concurrency).toBe(1);
	});
});

// The settings store is process-global — never leak overrides into other test files.
afterEach(() => systemSettingsStore.clearRuntimeValues());
