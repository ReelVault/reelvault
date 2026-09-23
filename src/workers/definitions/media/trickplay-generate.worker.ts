import { withDomainError } from "@/application/context";
import { trickplayService } from "@/modules/trickplay/trickplay.service";
import { serverConfig } from "@/server.config";
import { throwIfAborted } from "@/workers/utils/worker-cancellation";
import { workerService } from "@/workers/worker.service";
import { createWorkerDefinition, type WorkerEnqueueOptions } from "@/workers/worker.types";

// ─── Worker Definition ────────────────────────────────────────────────────────

export const trickplayGenerateWorker = createWorkerDefinition<{ mediaFileId: string }>(
	"trickplay-generate",
	() => serverConfig.workers.definitions.trickplayGenerate,
	({ data, logger, signal }) =>
		withDomainError(`Trickplay generation failed: ${data.mediaFileId}`, async () => {
			throwIfAborted(signal);
			const result = await trickplayService.generateForMediaFile(data.mediaFileId);
			if (result.skipped) {
				logger.info("Trickplay generation skipped", { mediaFileId: data.mediaFileId, reason: result.skipped });
			} else {
				logger.info("Trickplay generation finished", { ...result });
			}

			return result;
		}),
);

// ─── Enqueue Function ─────────────────────────────────────────────────────────

export async function enqueueTrickplayGeneration(mediaFileId: string, options: WorkerEnqueueOptions = {}) {
	return await workerService.addItem(
		trickplayGenerateWorker.id,
		{ mediaFileId },
		{
			...options,
			dedupeKey: mediaFileId,
			reference: { type: "media-file", id: mediaFileId },
		},
	);
}
