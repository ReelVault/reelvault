import { afterEach, describe, expect, test } from "bun:test";
import type { WorkerDefinition } from "@reelvault/sdk/common";
import { systemResourcesService } from "@/config/system-resources.service";
import { serverRescueService } from "@/system/server-rescue.service";
import { stubMethod } from "../../../tests/helpers/method-stub.helper";
import { WorkerRegistryService } from "./worker-registry.service";

// The registry runs against the real resource allocator and rescue service. The only host
// stub is the measured capacity behind auto concurrency: it depends on the machine running
// the tests. The rescue case stubs the rescue verdict because the rescue state machine is
// timer-driven; its transitions are covered by server-rescue.service.test.ts.
const stubs: Array<{ restore(): void }> = [];

afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
});

function def(overrides: Partial<WorkerDefinition> = {}): WorkerDefinition {
	return {
		id: "w-registry-test",
		handler: async () => undefined,
		...overrides,
	};
}

describe("WorkerRegistryService", () => {
	test("registers, looks up and unregisters worker definitions", () => {
		const registry = new WorkerRegistryService();

		expect(registry.has("w-registry-test")).toBe(false);
		expect(registry.get("w-registry-test")).toBeUndefined();
		expect(registry.size).toBe(0);

		registry.register(def());

		expect(registry.has("w-registry-test")).toBe(true);
		expect(registry.size).toBe(1);
		expect(registry.get("w-registry-test")?.id).toBe("w-registry-test");
		expect(registry.getAll().map((definition) => definition.id)).toEqual(["w-registry-test"]);

		expect(registry.unregister("w-registry-test")).toBe(true);
		expect(registry.unregister("w-registry-test")).toBe(false);
		expect(registry.has("w-registry-test")).toBe(false);
	});

	test("rejects a duplicate registration with a conflict code", () => {
		const registry = new WorkerRegistryService();
		registry.register(def());

		let failure: unknown;
		try {
			registry.register(def({ handler: async () => "other" }));
		} catch (error) {
			failure = error;
		}

		expect(failure).toMatchObject({ category: "conflict", code: "worker.already_registered" });
	});

	test("caps explicit concurrency at the allocator ceiling and keeps a lower value", () => {
		const registry = new WorkerRegistryService();
		registry.register(def({ id: "image-processing", concurrency: 10 }));
		registry.register(def({ id: "scanning", concurrency: 3 }));

		expect(registry.get("image-processing")?.concurrency).toBe(8);
		expect(registry.get("scanning")?.concurrency).toBe(3);
	});

	test("gives a worker without explicit concurrency the host's auto allocation", () => {
		stubs.push(stubMethod(systemResourcesService, "getWorkerAutoConcurrency", () => 2));

		const registry = new WorkerRegistryService();
		registry.register(def({ concurrency: 0 }));
		registry.register(def({ id: "w-registry-test-auto" }));

		expect(registry.get("w-registry-test")?.concurrency).toBe(2);
		expect(registry.get("w-registry-test-auto")?.concurrency).toBe(2);
	});

	test("a server rescue allocation overrides even explicit concurrency", () => {
		stubs.push(
			stubMethod(serverRescueService, "getRescueAllocation", () => ({
				allocated: 0,
				throttled: true as const,
				reason: "server_rescue" as const,
			})),
		);

		const registry = new WorkerRegistryService();
		registry.register(def({ concurrency: 8 }));

		expect(registry.get("w-registry-test")?.concurrency).toBe(0);
	});

	test("clamps attempts to a minimum of one", () => {
		const registry = new WorkerRegistryService();
		registry.register(def({ attempts: 0 }));

		expect(registry.get("w-registry-test")?.attempts).toBe(1);
	});
});
