import { afterEach, describe, expect, test } from "bun:test";
import { workerService } from "@/workers/worker.service";
import { registerPluginJobs, unregisterPluginJobs } from "./plugin.jobs";

const MAX_PLUGIN_JOB_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const registered: string[][] = [];

afterEach(() => {
	for (const names of registered.splice(0)) unregisterPluginJobs(names);
});

describe("plugin job clamps", () => {
	test("clamps plugin-declared concurrency and timeout to safe ceilings", async () => {
		const names = await registerPluginJobs("org.reelvault.clamp", [
			{
				name: "huge",
				handler: async () => undefined,
				options: { concurrency: 100_000, timeoutMs: 10 ** 12 },
			},
		]);
		registered.push(names);

		const definition = workerService.getDefinitions().find((candidate) => candidate.id === names[0]);
		expect(definition).toBeDefined();
		expect(definition?.concurrency).toBeGreaterThanOrEqual(1);
		expect(definition?.concurrency).toBeLessThanOrEqual(8);
		// `timeoutMs` scales with measured hardware, so allow the 2x slow-core headroom.
		expect(definition?.timeoutMs).toBeLessThanOrEqual(MAX_PLUGIN_JOB_TIMEOUT_MS * 2);
	});

	test("leaves an unspecified concurrency for hardware-based allocation", async () => {
		const names = await registerPluginJobs("org.reelvault.clamp", [{ name: "auto", handler: async () => undefined }]);
		registered.push(names);

		const definition = workerService.getDefinitions().find((candidate) => candidate.id === names[0]);
		expect(definition?.concurrency).toBeGreaterThanOrEqual(1);
	});
});
