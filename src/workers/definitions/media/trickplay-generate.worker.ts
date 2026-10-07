import { withDomainError } from "@/application/context";
import type { WorkerItem } from "@/database/repositories/worker.repository";
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

// ─── Enqueue Functions ────────────────────────────────────────────────────────

/** A real worker operation, so the admin UI can poll exactly what the route returned. */
export async function enqueueTrickplayGeneration(mediaFileId: string, options: WorkerEnqueueOptions = {}) {
	const { result } = await workerService.enqueueUnderOperation(
		{ type: trickplayGenerateWorker.id, reference: { type: "media-file", id: mediaFileId } },
		(operationId) =>
			workerService.addItem(
				trickplayGenerateWorker.id,
				{ mediaFileId },
				{ ...options, ...trickplayQueueOptions(mediaFileId), operationId },
			),
		// A dedupe hit keeps the existing job (and its operation) — drop the fresh one.
		{ isAttached: (item, operationId) => item.operationId === operationId },
	);

	return result;
}

function trickplayQueueOptions(mediaFileId: string) {
	return {
		dedupeKey: mediaFileId,
		reference: { type: "media-file", id: mediaFileId },
	};
}

/** One shared operation for the whole catalog pass (generate-all). */
export async function enqueueTrickplayGenerationMany(
	mediaFileIds: readonly string[],
): Promise<{ operationId: string | undefined; items: WorkerItem[] }> {
	if (mediaFileIds.length === 0) return { operationId: undefined, items: [] };

	const { operationId, result: items } = await workerService.enqueueUnderOperation(
		{ type: trickplayGenerateWorker.id, reference: { type: "media-file", id: "all" } },
		(opId) =>
			workerService.addItems(
				trickplayGenerateWorker.id,
				mediaFileIds.map((mediaFileId) => ({
					data: { mediaFileId },
					options: { ...trickplayQueueOptions(mediaFileId), operationId: opId },
				})),
			),
		{ isAttached: (queued, opId) => queued.some((item) => item.operationId === opId) },
	);

	return { operationId, items };
}
