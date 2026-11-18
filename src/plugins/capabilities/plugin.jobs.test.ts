import { afterEach, describe, expect, test } from "bun:test";
import { systemResourcesService } from "@/config/system-resources.service";
import { workerOperationsService } from "@/workers/core/worker-operations.service";
import { workerService } from "@/workers/worker.service";
import { type MethodStub, stubMethod } from "../../../tests/helpers/method-stub.helper";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { pluginJobsService } from "./plugin.jobs";

useTestDatabase();

const MAX_PLUGIN_JOB_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const MAX_PLUGIN_JOB_ATTEMPTS = 25;
// Plugin jobs belong to no resource category, so the worker ceiling is the default one.
const PLUGIN_JOB_CONCURRENCY_CEILING = 4;
const registered: string[][] = [];
const stubs: MethodStub[] = [];

afterEach(async () => {
	for (const names of registered.splice(0)) await pluginJobsService.unregister(names);
	for (const stub of stubs.splice(0).toReversed()) stub.restore();
});

describe("plugin job clamps", () => {
	test("clamps plugin-declared concurrency and timeout to the worker and job ceilings", async () => {
		// The registry scales the timeout by the host's measured speed; the scale is pinned so only the clamp is measured.
		stubs.push(stubMethod(systemResourcesService, "scaledTimeoutMs", (baseMs: number) => baseMs));
		const names = await pluginJobsService.register("org.reelvault.clamp", [
			{
				name: "huge",
				handler: async () => undefined,
				options: { concurrency: 100_000, timeoutMs: 10 ** 12, attempts: 1_000_000 },
			},
		]);
		registered.push(names);

		const definition = workerService.getDefinitions().find((candidate) => candidate.id === names[0]);
		expect(definition?.concurrency).toBe(PLUGIN_JOB_CONCURRENCY_CEILING);
		expect(definition?.timeoutMs).toBe(MAX_PLUGIN_JOB_TIMEOUT_MS);
		expect(definition?.attempts).toBe(MAX_PLUGIN_JOB_ATTEMPTS);
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

describe("plugin job name validation", () => {
	test("refuses to register a job without a name", async () => {
		await expect(pluginJobsService.register("org.reelvault.jobs", [{ name: "", handler: async () => undefined }])).rejects.toMatchObject({
			category: "validation",
			code: "plugin.job_name_required",
		});
	});

	test("refuses to enqueue a job without a name", async () => {
		await expect(pluginJobsService.enqueue("org.reelvault.jobs", "", {})).rejects.toMatchObject({
			category: "validation",
			code: "plugin.job_name_required",
		});
	});

	test("reports the validation code when a batch enqueue has no name", async () => {
		await expect(pluginJobsService.enqueueMany("org.reelvault.jobs", "", [{ data: {} }])).rejects.toMatchObject({
			category: "validation",
			code: "plugin.job_name_required",
		});
	});
});

describe("plugin job enqueue operations", () => {
	test("records the plugin as the operation reference for a batch enqueue", async () => {
		const names = await pluginJobsService.register("org.reelvault.ref", [{ name: "batch", handler: async () => undefined }]);
		registered.push(names);

		const handles = await pluginJobsService.enqueueMany("org.reelvault.ref", "batch", [{ data: {} }, { data: {} }]);
		const handle = handles[0];
		if (!handle) throw new Error("Expected a queued job handle");
		if (!handle.operationId) throw new Error("Expected the queued job to carry an operation id");

		const operation = await workerOperationsService.getById(handle.operationId);

		expect(operation).toMatchObject({
			type: "org.reelvault.ref:batch",
			referenceType: "plugin",
			referenceId: "org.reelvault.ref",
		});
	});
});
