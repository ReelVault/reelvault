import type { ApplicationContext } from "@/application/context";
import { systemResourcesService } from "@/system/system-resources.service";
import { PromiseUtils } from "@/utils/promise.utils";
import { batchChunks } from "@/workers/utils/batch-chunker";
import { ENQUEUE_BATCH_SIZE } from "@/workers/worker.constants";
import type { WorkerEnqueueOptions } from "@/workers/worker.types";

export interface ScanAndEnqueueResult {
	requested: number;
	queued: number;
}

export interface ScanAndEnqueueOptions<TId, T> {
	context: ApplicationContext;
	findIds: (signal?: AbortSignal) => Promise<TId[]>;
	/** Maps a scanned id to the task payload enqueued for it. */
	toData: (id: TId) => T;
	enqueueItem: (item: T, options: WorkerEnqueueOptions) => Promise<unknown>;
	enqueueMany?: (items: T[], options: WorkerEnqueueOptions) => Promise<unknown> | undefined;
	label: string;
}

/**
 * Generic scan-and-enqueue pattern: fetch IDs, map each to its task payload,
 * then batch-enqueue them. Shared by image-optimization-all,
 * media-match-audit-all, and media-files-refresh-all workers.
 */
export async function scanAndEnqueueTask<TId, T>({
	context,
	findIds,
	toData,
	enqueueItem,
	enqueueMany,
	label,
}: ScanAndEnqueueOptions<TId, T>): Promise<ScanAndEnqueueResult> {
	const startedAt = performance.now();
	const ids = await findIds(context.signal);
	const schedulingOptions: WorkerEnqueueOptions = {
		operationId: context.operationId,
		dependsOnTaskIds: context.taskId ? [context.taskId] : undefined,
	};

	let queued = 0;
	if (enqueueMany) {
		for (const { items: idChunk } of batchChunks(ids, ENQUEUE_BATCH_SIZE)) {
			context.signal?.throwIfAborted();
			await enqueueMany(
				idChunk.map((id) => toData(id)),
				schedulingOptions,
			);
			queued += idChunk.length;
		}
	} else {
		await PromiseUtils.mapConcurrent(
			ids,
			systemResourcesService.getIngestConcurrency(),
			async (id) => {
				await enqueueItem(toData(id), schedulingOptions);
				queued++;
			},
			context.signal,
		);
	}

	context.logger?.info(label, {
		requested: ids.length,
		queued,
		durationMs: Math.round(performance.now() - startedAt),
	});

	return { requested: ids.length, queued };
}
