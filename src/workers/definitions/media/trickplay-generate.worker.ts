import { withDomainError } from "@/application/context";
import type { WorkerItem } from "@/database/repositories/worker.repository";
import { workerOperationRepository } from "@/database/repositories/worker-operation.repository";
import { trickplayService } from "@/modules/trickplay/trickplay.service";
import { serverConfig } from "@/server.config";
import { KeyedMutex } from "@/utils/mutex";
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
			if (result.skipped === "storage-budget") {
				logger.warn("Trickplay generation skipped: artifact storage budget exhausted", { mediaFileId: data.mediaFileId });
			} else if (result.skipped) {
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

/** Serialises find-or-create per library so concurrent ingests join one operation. */
const libraryTrickplayLocks = new KeyedMutex();

/**
 * Scan/refresh-triggered generation joins ONE active operation per library:
 * the first file creates it, every later file attaches to it, and it completes
 * when the batch drains. Admin-triggered generation keeps its own operations.
 */
export async function enqueueTrickplayGenerationForLibrary(mediaFileId: string, libraryId: string): Promise<WorkerItem> {
	return await libraryTrickplayLocks.runExclusive(libraryId, async () => {
		const existing = await workerOperationRepository.findActiveByReference(trickplayGenerateWorker.id, "library", libraryId);
		const operationId =
			existing?.id ??
			(await workerService.createOperation({ type: trickplayGenerateWorker.id, reference: { type: "library", id: libraryId } })).id;

		try {
			const item = await workerService.addItem(
				trickplayGenerateWorker.id,
				{ mediaFileId },
				{ ...trickplayQueueOptions(mediaFileId), operationId },
			);

			// A dedupe hit returns the pre-existing job (with its own operation) —
			// remove a freshly created operation that ended up with zero items.
			if (!existing && item.operationId !== operationId) {
				await workerService.removeOperation(operationId).catch(() => {
					// best-effort cleanup
				});
			}

			return item;
		} catch (error) {
			if (!existing) {
				await workerService.removeOperation(operationId).catch(() => {
					// best-effort cleanup
				});
			}

			throw error;
		}
	});
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
