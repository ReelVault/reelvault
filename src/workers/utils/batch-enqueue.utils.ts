import { systemResourcesService } from "@/config/system-resources.service";
import { mapConcurrent } from "@/utils/promise.utils";
import { batchChunks } from "@/workers/utils/batch-chunker.utils";
import { ENQUEUE_BATCH_SIZE } from "@/workers/worker.constants";

export interface EnqueueInBatchesOptions<T> {
	items: readonly T[];
	/** Resume point for a persisted cursor; defaults to 0. */
	cursor?: number | undefined;
	/** Batched insert path — preferred, because per-item inserts serialize on SQLite. */
	batch?: ((chunk: T[]) => Promise<unknown>) | undefined;
	/** Fallback for custom per-item dependencies. */
	item: (entry: T) => Promise<unknown>;
	/** Called after every batch (and once at the end of the item fallback). */
	onChunk?: ((nextCursor: number) => Promise<void> | void) | undefined;
	signal?: AbortSignal | undefined;
}

/**
 * Enqueues `items` from `cursor` on: one batched call per chunk when `batch` is
 * given, otherwise bounded per-item concurrency. The cursor is advanced only
 * after a chunk succeeded, so an abort resumes from the last persisted chunk.
 */
export async function enqueueInBatches<T>({
	items,
	cursor = 0,
	batch,
	item,
	onChunk,
	signal,
}: EnqueueInBatchesOptions<T>): Promise<{ queued: number; cursor: number }> {
	if (batch) {
		let queued = 0;
		let nextCursor = cursor;
		for (const { items: chunk, nextCursor: chunkEnd } of batchChunks(items, ENQUEUE_BATCH_SIZE, cursor)) {
			signal?.throwIfAborted();
			await batch(chunk);
			nextCursor = chunkEnd;
			queued += chunk.length;
			await onChunk?.(nextCursor);
		}

		return { queued, cursor: nextCursor };
	}

	const remaining = items.slice(cursor);
	if (remaining.length === 0) {
		await onChunk?.(cursor);

		return { queued: 0, cursor };
	}

	await mapConcurrent(remaining, systemResourcesService.getIngestConcurrency(), item, signal);
	await onChunk?.(items.length);

	return { queued: remaining.length, cursor: items.length };
}
