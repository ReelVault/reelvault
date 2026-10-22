import { afterEach, describe, expect, test } from "bun:test";
import { workerService } from "@/workers/worker.service";
import { pluginJobsService } from "./plugin.jobs";

const MAX_PLUGIN_JOB_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const registered: string[][] = [];

afterEach(async () => {
	for (const names of registered.splice(0)) await pluginJobsService.unregister(names);
});

describe("plugin job clamps", () => {
	test("clamps plugin-declared concurrency and timeout to safe ceilings", async () => {
		const names = await pluginJobsService.register("org.reelvault.clamp", [
			{
				name: "huge",
				handler: async () => undefined,
				options: { concurrency: 100_000, timeoutMs: 10 ** 12 },
			},
		]);
		registered.push(names);

		const definition = workerService.getDefinitions().find((candidate) => candidate.id === names[0]);
		expect(definition?.concurrency).toBeGreaterThanOrEqual(1);
		expect(definition?.concurrency).toBeLessThanOrEqual(8);
		// `timeoutMs` scales with measured hardware, so allow the 2x slow-core headroom.
		expect(definition?.timeoutMs).toBeLessThanOrEqual(MAX_PLUGIN_JOB_TIMEOUT_MS * 2);
	});

	test("namespaces a local job name with its plugin id", async () => {
		const names = await pluginJobsService.register("org.reelvault.trickplay", [{ name: "generate", handler: async () => undefined }]);
		registered.push(names);

		expect(names).toEqual(["org.reelvault.trickplay:generate"]);
	});

	test("registers a job without a declared concurrency with a concurrency of one", async () => {
		const names = await pluginJobsService.register("org.reelvault.clamp", [{ name: "auto", handler: async () => undefined }]);
		registered.push(names);

		const definition = workerService.getDefinitions().find((candidate) => candidate.id === names[0]);
		// A plugin job belongs to no resource category, so the allocator gives it the
		// unbudgeted default of a single slot.
		expect(definition?.concurrency).toBe(1);
	});
});
