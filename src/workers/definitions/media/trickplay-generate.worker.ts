import { serverConfig } from "@/config/server/server.config";
import { MINUTE } from "@/config/server/server.constants";
import { trickplayService } from "@/modules/trickplay/trickplay.service";
import type { WorkerItem } from "@/repositories/worker-jobs/shared.types";
import { workerOperationRepository } from "@/repositories/worker-operation.repository";
import { throwIfAborted } from "@/utils/cancellation.utils";
import { KeyedMutex } from "@/utils/concurrency.utils";
import { withDomainError } from "@/utils/domain.errors";
import { anyAttachedToOperation, attachedToOperation, enqueueWithOperation } from "@/workers/core/worker-operation.service";
import { workerService } from "@/workers/worker.service";
import { createWorkerDefinition, type WorkerEnqueueOptions } from "@/workers/worker.types";

// ─── Worker Definition ────────────────────────────────────────────────────────

/** A short gap between files keeps the queue from saturating a slow library disk. */
const TRICKPLAY_JOB_COOLDOWN_MS = 5_000;

export const trickplayGenerateWorker = createWorkerDefinition<{ mediaFileId: string }>(
	"trickplay-generate",
	() => serverConfig.workers.definitions.trickplayGenerate,
	({ data, logger, signal, extendTimeout }) =>
		withDomainError(`Trickplay generation failed: ${data.mediaFileId}`, async () => {
			throwIfAborted(signal);
			const result = await trickplayService.generateForMediaFile(data.mediaFileId, signal, {
				// A healthy long file must not be killed by the fixed stall timeout;
				// every completed frame or sprite proves the task is still moving.
				onProgress: () => extendTimeout?.(10 * MINUTE),
			});
			if (result.skipped === "storage-budget") {
				logger.warn("Trickplay generation skipped: artifact storage budget exhausted", { mediaFileId: data.mediaFileId });
			} else if (result.skipped === "storage-degraded") {
				logger.warn("Trickplay generation skipped: storage is degraded", { mediaFileId: data.mediaFileId });
			} else if (result.skipped) {
				logger.info("Trickplay generation skipped", { mediaFileId: data.mediaFileId, reason: result.skipped });
			} else {
				logger.info("Trickplay generation finished", { ...result });
			}

			await Bun.sleep(TRICKPLAY_JOB_COOLDOWN_MS);

			return result;
		}),
);

// ─── Enqueue Functions ────────────────────────────────────────────────────────

/** A real worker operation, so the admin UI can poll exactly what the route returned. */
export async function enqueueTrickplayGeneration(mediaFileId: string, options: WorkerEnqueueOptions = {}) {
	const { result } = await enqueueWithOperation(
		{ type: trickplayGenerateWorker.id, reference: { type: "media-file", id: mediaFileId } },
		(operationId) =>
			workerService.addItem(
				trickplayGenerateWorker.id,
				{ mediaFileId },
				{ ...options, ...trickplayQueueOptions(mediaFileId), operationId },
			),
		// A dedupe hit keeps the existing job (and its operation) — drop the fresh one.
		{ isAttached: attachedToOperation },
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
		// A dedupe hit returns the pre-existing job (with its own operation); the
		// helper drops a freshly created operation that ended up with zero items.
		const { result } = await enqueueWithOperation(
			{ type: trickplayGenerateWorker.id, reference: { type: "library", id: libraryId } },
			(operationId) =>
				workerService.addItem(trickplayGenerateWorker.id, { mediaFileId }, { ...trickplayQueueOptions(mediaFileId), operationId }),
			{ operationId: existing?.id, isAttached: attachedToOperation },
		);

		return result;
	});
}

/** One shared operation for the whole catalog pass (generate-all). */
export async function enqueueTrickplayGenerationMany(
	mediaFileIds: readonly string[],
): Promise<{ operationId: string | undefined; items: WorkerItem[] }> {
	if (mediaFileIds.length === 0) return { operationId: undefined, items: [] };

	const { operationId, result: items } = await enqueueWithOperation(
		{ type: trickplayGenerateWorker.id, reference: { type: "media-file", id: "all" } },
		(opId) =>
			workerService.addItems(
				trickplayGenerateWorker.id,
				mediaFileIds.map((mediaFileId) => ({
					data: { mediaFileId },
					options: { ...trickplayQueueOptions(mediaFileId), operationId: opId },
				})),
			),
		{ isAttached: anyAttachedToOperation },
	);

	return { operationId, items };
}
