import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { workerOperationRepository } from "@/database/repositories/worker-operation.repository";
import { workerService } from "@/workers/worker.service";
import { stubMethod } from "../../../../tests/helpers/method-stub";
import { enqueueTrickplayGenerationForLibrary } from "./trickplay-generate.worker";

const activeStubs: Array<{ restore(): void }> = [];

beforeEach(() => {
	activeStubs.length = 0;
});

afterEach(() => {
	for (const stub of activeStubs.toReversed()) stub.restore();
});

interface CapturedEnqueue {
	operationId?: string;
	dedupeKey?: string;
	reference?: { type: string; id: string };
}

function stubOperationCreation(): { created: string[] } {
	const created: string[] = [];
	activeStubs.push(
		stubMethod(workerService, "createOperation", (input: { type: string }) => {
			const id = `op-${created.length + 1}`;
			created.push(id);

			return Promise.resolve({ id, type: input.type });
		}),
	);

	return { created };
}

describe("enqueueTrickplayGenerationForLibrary", () => {
	test("creates a library operation and attaches the first job to it", async () => {
		const { created } = stubOperationCreation();
		const removed: string[] = [];
		const enqueued: CapturedEnqueue[] = [];
		activeStubs.push(
			stubMethod(workerOperationRepository, "findActiveByReference", () => Promise.resolve(undefined)),
			stubMethod(workerService, "addItem", (_workerId: string, _data: unknown, options: CapturedEnqueue) => {
				enqueued.push(options);

				return Promise.resolve({ id: "job-1", operationId: options.operationId });
			}),
			stubMethod(workerService, "removeOperation", (id: string) => {
				removed.push(id);

				return Promise.resolve();
			}),
		);

		const item = await enqueueTrickplayGenerationForLibrary("mf-1", "library-a");

		expect(created).toEqual(["op-1"]);
		expect(enqueued).toEqual([{ operationId: "op-1", dedupeKey: "mf-1", reference: { type: "media-file", id: "mf-1" } }]);
		expect(removed).toHaveLength(0);
		expect(item).toMatchObject({ operationId: "op-1" });
	});

	test("joins the active library operation instead of creating a new one", async () => {
		const { created } = stubOperationCreation();
		const enqueued: CapturedEnqueue[] = [];
		activeStubs.push(
			stubMethod(workerOperationRepository, "findActiveByReference", () => Promise.resolve({ id: "op-active" })),
			stubMethod(workerService, "addItem", (_workerId: string, _data: unknown, options: CapturedEnqueue) => {
				enqueued.push(options);

				return Promise.resolve({ id: "job-2", operationId: options.operationId });
			}),
		);

		await enqueueTrickplayGenerationForLibrary("mf-2", "library-b");

		expect(created).toHaveLength(0);
		expect(enqueued).toEqual([{ operationId: "op-active", dedupeKey: "mf-2", reference: { type: "media-file", id: "mf-2" } }]);
	});

	test("removes the fresh operation when the job dedupes onto another operation", async () => {
		stubOperationCreation();
		const removed: string[] = [];
		activeStubs.push(
			stubMethod(workerOperationRepository, "findActiveByReference", () => Promise.resolve(undefined)),
			stubMethod(workerService, "addItem", () => Promise.resolve({ id: "job-3", operationId: "op-elsewhere" })),
			stubMethod(workerService, "removeOperation", (id: string) => {
				removed.push(id);

				return Promise.resolve();
			}),
		);

		await enqueueTrickplayGenerationForLibrary("mf-3", "library-c");

		expect(removed).toEqual(["op-1"]);
	});

	test("removes the fresh operation and rethrows when the enqueue fails", async () => {
		stubOperationCreation();
		const removed: string[] = [];
		activeStubs.push(
			stubMethod(workerOperationRepository, "findActiveByReference", () => Promise.resolve(undefined)),
			stubMethod(workerService, "addItem", () => Promise.reject(new Error("enqueue failed"))),
			stubMethod(workerService, "removeOperation", (id: string) => {
				removed.push(id);

				return Promise.resolve();
			}),
		);

		await expect(enqueueTrickplayGenerationForLibrary("mf-4", "library-d")).rejects.toThrow("enqueue failed");
		expect(removed).toEqual(["op-1"]);
	});
});
