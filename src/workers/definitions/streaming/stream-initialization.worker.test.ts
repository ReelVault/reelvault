import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AddWorkerItemOptions, Logger, PlaybackDecision } from "@reelvault/sdk/common";
import type { ApplicationContext } from "@/application/context";
import type { WorkerItem } from "@/database/repositories/worker.repository";
import type { StreamInitData } from "@/modules/streaming/runtime/stream-initializer";
import { createMockWorkerItem } from "@/workers/core/worker-runtime.test-utils";
import { enqueueStreamInit, streamInitWorker } from "./stream-initialization.worker";

const decision: PlaybackDecision = {
	mode: "direct-stream",
	videoTranscode: false,
	audioTranscode: false,
	reason: "test",
};

function noopLogger(): Logger {
	const noop = () => undefined;

	return {
		trace: noop,
		debug: noop,
		info: noop,
		warn: noop,
		error: noop,
		fatal: noop,
		child: () => noopLogger(),
		time: () => () => undefined,
	};
}

/** Replaces a method on the live singleton for one test, recording calls.
 * Works on real repositories AND on the minimal facades other test files
 * install with bun's process-global mock.module(...). */
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

const activeStubs: Array<{ restore(): void }> = [];

beforeEach(async () => {
	const { streamInitializer } = await import("@/modules/streaming/runtime/stream-initializer");
	activeStubs.push(stubMethod(streamInitializer, "initialize", () => Promise.resolve({ success: true, message: "initializer stubbed" })));
});

afterEach(() => {
	for (const stub of activeStubs.splice(0)) stub.restore();
});

describe("stream-initialization worker", () => {
	test("delegates its handler to the stream initializer with the job context", async () => {
		let receivedContext: ApplicationContext | undefined;
		const { streamInitializer } = await import("@/modules/streaming/runtime/stream-initializer");
		activeStubs.push(
			stubMethod(streamInitializer, "initialize", (_data: StreamInitData, context: ApplicationContext) => {
				receivedContext = context;

				return Promise.resolve({ success: true, message: "delegated" });
			}),
		);

		const signal = new AbortController().signal;
		const logger = noopLogger();
		const result = await streamInitWorker.handler({
			taskId: "task-1",
			workerId: "stream-init",
			operationId: "operation-9",
			data: { sessionId: "session-1", mediaFileId: "media-1", filePath: "/media/movie.mkv", decision },
			attempt: 1,
			signal,
			logger,
		});

		expect(result).toEqual({ success: true, message: "delegated" });
		expect(receivedContext).toMatchObject({
			signal,
			logger,
			operationId: "operation-9",
			correlationId: "operation-9",
			taskId: "task-1",
		});
	});

	test("enqueues onto the stream-init worker with the session dedupe key", async () => {
		const { workerService } = await import("@/workers/worker.service");
		const item: WorkerItem = createMockWorkerItem({ id: "job-1", workerId: "stream-init" });
		const addItemCalls: Array<[string, unknown, AddWorkerItemOptions]> = [];
		const originalAddItem = Reflect.get(workerService, "addItem");
		Reflect.set(workerService, "addItem", (workerId: string, itemData: unknown, options: AddWorkerItemOptions) => {
			addItemCalls.push([workerId, itemData, options]);

			return Promise.resolve(item);
		});
		activeStubs.push({ restore: () => Reflect.set(workerService, "addItem", originalAddItem) });

		const data = { sessionId: "session-1", mediaFileId: "media-1", filePath: "/media/movie.mkv", decision };
		await expect(enqueueStreamInit(data, { operationId: "operation-1" })).resolves.toBe(item);

		expect(addItemCalls).toEqual([
			["stream-init", data, { operationId: "operation-1", dedupeKey: "session-1", reference: { type: "media-file", id: "media-1" } }],
		]);
	});
});
