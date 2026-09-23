import { type StreamInitData, streamInitializer } from "@/modules/streaming/runtime/stream-initializer";
import { serverConfig } from "@/server.config";
import { workerService } from "@/workers/worker.service";
import { createWorkerDefinition, type WorkerEnqueueOptions } from "@/workers/worker.types";

// ─── Worker Definition ────────────────────────────────────────────────────────

export const streamInitWorker = createWorkerDefinition<StreamInitData>(
	"stream-init",
	() => serverConfig.workers.definitions.streamInitialization,
	async ({ data, logger, signal, operationId, taskId }) =>
		await streamInitializer.initialize(data, { signal, logger, operationId, correlationId: operationId, taskId }),
);

// ─── Enqueue Function ─────────────────────────────────────────────────────────

export function enqueueStreamInit(data: StreamInitData, options: WorkerEnqueueOptions = {}) {
	return workerService.addItem(streamInitWorker.id, data, {
		...options,
		dedupeKey: data.sessionId,
		reference: { type: "media-file", id: data.mediaFileId },
	});
}
