import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WorkerDefinition } from "@reelvault/sdk/common";
import { MINUTE } from "@/server.constants";

const activeStubs: Array<{ restore(): void }> = [];

function stubMethod<TArgs extends unknown[]>(
	target: object,
	method: string,
	impl: (...args: TArgs) => unknown,
): { calls: TArgs[]; restore(): void } {
	const original = Reflect.get(target, method);
	const calls: TArgs[] = [];
	Reflect.set(target, method, (...args: TArgs) => {
		calls.push(args);

		return impl(...args);
	});

	return {
		calls,
		restore: () => {
			if (original === undefined) Reflect.deleteProperty(target, method);
			else Reflect.set(target, method, original);
		},
	};
}

beforeEach(async () => {
	const [{ serverRescueService }, { resourceAllocator }, { systemResourcesService }] = await Promise.all([
		import("@/system/server-rescue.service"),
		import("@/system/resource-allocator"),
		import("@/system/system-resources.service"),
	]);
	activeStubs.push(
		stubMethod(serverRescueService, "getRescueAllocation", () => undefined),
		stubMethod(resourceAllocator, "getWorkerConcurrencyCeiling", () => 4),
		stubMethod(resourceAllocator, "getWorkerAllocation", (workerId: string) => ({
			workerId,
			requested: 99,
			allocated: 2,
			throttled: false,
		})),
		stubMethod(systemResourcesService, "scaledTimeoutMs", (baseMs: number) => baseMs),
	);
});

afterEach(() => {
	for (const stub of activeStubs.splice(0)) stub.restore();
});

const ALREADY_REGISTERED = /already registered/;

function def(overrides: Partial<WorkerDefinition> = {}): WorkerDefinition {
	return {
		id: "w-registry-test",
		handler: async () => undefined,
		...overrides,
	};
}

describe("WorkerRegistryService", () => {
	test("registers, looks up and unregisters worker definitions", async () => {
		const { WorkerRegistryService } = await import("./worker-registry.service");
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

	test("rejects a duplicate registration with a ConflictError", async () => {
		const { WorkerRegistryService } = await import("./worker-registry.service");
		const registry = new WorkerRegistryService();
		registry.register(def());

		expect(() => registry.register(def({ handler: async () => "other" }))).toThrow(ALREADY_REGISTERED);
	});

	test("normalizes explicit concurrency against the allocator ceiling", async () => {
		const { WorkerRegistryService } = await import("./worker-registry.service");
		const { resourceAllocator } = await import("@/system/resource-allocator");
		const ceiling = stubMethod<[string]>(resourceAllocator, "getWorkerConcurrencyCeiling", () => 4);
		activeStubs.push(ceiling);

		const registry = new WorkerRegistryService();
		registry.register(def({ concurrency: 10 }));

		const stored = registry.get("w-registry-test");
		expect(stored?.concurrency).toBe(4);
		expect(ceiling.calls).toEqual([["w-registry-test"]]);
	});

	test("falls back to the allocator for zero or missing concurrency", async () => {
		const { WorkerRegistryService } = await import("./worker-registry.service");
		const { resourceAllocator } = await import("@/system/resource-allocator");
		const allocation = stubMethod(resourceAllocator, "getWorkerAllocation", (workerId: string) => ({
			workerId,
			requested: 8,
			allocated: 2,
			throttled: true,
		}));
		activeStubs.push(allocation);

		const registry = new WorkerRegistryService();
		registry.register(def({ concurrency: 0 }));
		registry.register(def({ id: "w-registry-test-auto" }));

		expect(registry.get("w-registry-test")?.concurrency).toBe(2);
		expect(registry.get("w-registry-test-auto")?.concurrency).toBe(2);
	});

	test("a server rescue allocation overrides even explicit concurrency", async () => {
		const { WorkerRegistryService } = await import("./worker-registry.service");
		const { serverRescueService } = await import("@/system/server-rescue.service");
		activeStubs.push(
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

	test("fills attempts, backoff and timeoutMs defaults from the scheduling config", async () => {
		const { WorkerRegistryService } = await import("./worker-registry.service");
		const registry = new WorkerRegistryService();
		registry.register(def());

		const stored = registry.get("w-registry-test");
		expect(stored?.attempts).toBe(3);
		expect(stored?.backoff).toEqual({ type: "exponential", delayMs: 1_000 });
		expect(stored?.timeoutMs).toBe(5 * MINUTE);
	});

	test("keeps explicit attempts, backoff and timeoutMs", async () => {
		const { WorkerRegistryService } = await import("./worker-registry.service");
		const registry = new WorkerRegistryService();
		registry.register(
			def({
				attempts: 5,
				backoff: { type: "fixed", delayMs: 2_500 },
				timeoutMs: 45_000,
			}),
		);

		const stored = registry.get("w-registry-test");
		expect(stored?.attempts).toBe(5);
		expect(stored?.backoff).toEqual({ type: "fixed", delayMs: 2_500 });
		expect(stored?.timeoutMs).toBe(45_000);
	});

	test("clamps attempts to a minimum of one", async () => {
		const { WorkerRegistryService } = await import("./worker-registry.service");
		const registry = new WorkerRegistryService();
		registry.register(def({ attempts: 0 }));

		expect(registry.get("w-registry-test")?.attempts).toBe(1);
	});
});
