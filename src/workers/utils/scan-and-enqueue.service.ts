import type { ApplicationContext } from "@/utils/task-context.types";
import { enqueueInBatches } from "@/workers/utils/batch-enqueue.utils";
import type { WorkerEnqueueOptions } from "@/workers/worker.types";

export interface ScanAndEnqueueResult {
	requested: number;
	queued: number;
}

export interface ScanAndEnqueueOptions<TId, T> {
	context: ApplicationContext;
	/** Full id list — fine for bounded scans. Ignored when `scanPages` is provided. */
	findIds?: ((signal?: AbortSignal) => Promise<TId[]>) | undefined;
	/**
	 * Streaming producer: calls `onPage` once per keyset page and returns the
	 * total. Takes precedence over `findIds` — a full-catalog scan must not
	 * materialize every id before enqueueing the first batch.
	 */
	scanPages?: ((onPage: (ids: TId[]) => Promise<void> | void) => Promise<number>) | undefined;
	/** Maps a scanned id to the task payload enqueued for it. */
	toData: (id: TId) => T;
	enqueueItem: (item: T, options: WorkerEnqueueOptions) => Promise<unknown>;
	enqueueMany?: ((items: T[], options: WorkerEnqueueOptions) => Promise<unknown>) | undefined;
	label: string;
}

/**
 * Generic scan-and-enqueue pattern: fetch ids (or stream pages), map each to its
 * task payload, then batch-enqueue them. Shared by image-optimization-all,
 * media-match-audit-all, and media-files-refresh-all workers.
 */
export async function scanAndEnqueueTask<TId, T>({
	context,
	findIds,
	scanPages,
	toData,
	enqueueItem,
	enqueueMany,
	label,
}: ScanAndEnqueueOptions<TId, T>): Promise<ScanAndEnqueueResult> {
	const startedAt = performance.now();
	const schedulingOptions: WorkerEnqueueOptions = {
		operationId: context.operationId,
		dependsOnTaskIds: context.taskId ? [context.taskId] : undefined,
	};

	let requested = 0;
	let queued = 0;
	const enqueuePage = async (ids: TId[]): Promise<void> => {
		requested += ids.length;
		let batch: ((chunk: TId[]) => Promise<unknown>) | undefined;
		if (enqueueMany) {
			batch = async (chunk) =>
				await enqueueMany(
					chunk.map((id) => toData(id)),
					schedulingOptions,
				);
		}

		const result = await enqueueInBatches({
			items: ids,
			batch,
			item: async (id) => await enqueueItem(toData(id), schedulingOptions),
			signal: context.signal,
		});
		queued += result.queued;
	};

	if (scanPages) {
		await scanPages(async (ids) => {
			context.signal?.throwIfAborted();
			await enqueuePage(ids);
		});
	} else {
		const ids = (await findIds?.(context.signal)) ?? [];
		await enqueuePage(ids);
	}

	context.logger?.info(label, {
		requested,
		queued,
		durationMs: Math.round(performance.now() - startedAt),
	});

	return { requested, queued };
}
