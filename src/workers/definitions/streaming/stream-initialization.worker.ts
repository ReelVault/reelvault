import { serverConfig } from "@/config/server/server.config";
import { type StreamInitData, streamInitializer } from "@/modules/streaming/runtime/stream.initializer";
import { toApplicationContext } from "@/workers/utils/task-context.mapper";
import { defineWorkerEnqueue } from "@/workers/utils/worker-enqueue.utils";
import { createWorkerDefinition } from "@/workers/worker.types";

// ─── Worker Definition ────────────────────────────────────────────────────────

export const streamInitWorker = createWorkerDefinition<StreamInitData>(
	"stream-init",
	() => serverConfig.workers.definitions.streamInitialization,
	async (context) => await streamInitializer.initialize(context.data, toApplicationContext(context)),
);

// ─── Enqueue Function ─────────────────────────────────────────────────────────

const streamInitEnqueue = defineWorkerEnqueue<StreamInitData>(streamInitWorker.id, (data) => ({
	dedupeKey: data.sessionId,
	reference: { type: "media-file", id: data.mediaFileId },
}));

export const enqueueStreamInit = streamInitEnqueue.enqueue;
