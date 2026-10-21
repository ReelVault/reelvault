import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Logger, PlaybackDecision } from "@reelvault/sdk/common";
import type { StreamInitData } from "@/modules/streaming/runtime/stream.initializer";
import { workerOperationRepository } from "@/repositories/worker-operation.repository";
import type { ApplicationContext } from "@/utils/task-context.types";
import { workerService } from "@/workers/worker.service";
import { stubMethod } from "../../../../tests/helpers/method-stub.helper";
import { useTestDatabase } from "../../../../tests/helpers/test-database.helper";
import { enqueueStreamInit, streamInitWorker } from "./stream-initialization.worker";

// The enqueue test writes a real job row under an operation.
useTestDatabase();

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

const activeStubs: Array<{ restore(): void }> = [];

beforeEach(() => {
	workerService.registry.register(streamInitWorker);
});

afterEach(() => {
	for (const stub of activeStubs.splice(0)) stub.restore();
	workerService.registry.unregister(streamInitWorker.id);
});

describe("stream-initialization worker", () => {
	test("delegates its handler to the stream initializer with the job context", async () => {
		let receivedContext: ApplicationContext | undefined;
		const { streamInitializer } = await import("@/modules/streaming/runtime/stream.initializer");
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

	test("enqueues onto the stream-init worker keyed by session and referencing the media file", async () => {
		await workerOperationRepository.create({ id: "operation-1", type: "stream-init" });
		const data = { sessionId: "session-1", mediaFileId: "media-1", filePath: "/media/movie.mkv", decision };

		const item = await enqueueStreamInit(data, { operationId: "operation-1" });

		expect(item).toMatchObject({
			workerId: streamInitWorker.id,
			operationId: "operation-1",
			dedupeKey: "session-1",
			referenceType: "media-file",
			referenceId: "media-1",
		});
	});
});
