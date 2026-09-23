import type { ApplicationContext } from "@/application/context";
import { type ScanAndEnqueueResult, scanAndEnqueueTask } from "@/workers/utils/scan-and-enqueue";
import type { WorkerEnqueueOptions } from "@/workers/worker.types";

export interface ScanFanoutInput<TData> {
	context: ApplicationContext;
	/** Success log line summarizing requested/queued counts. */
	label: string;
	findIds: (signal?: AbortSignal) => Promise<string[]>;
	toData: (id: string) => TData;
	enqueue: (data: TData, options: WorkerEnqueueOptions) => Promise<unknown>;
	/** Optional batched variant — used preferentially to avoid one INSERT per item. */
	enqueueMany?: ((items: TData[], options: WorkerEnqueueOptions) => Promise<unknown>) | undefined;
}

/**
 * Fan-out of a scan worker: fetch candidate ids, then enqueue one task per id
 * (batched when the dependencies support it). Shared wiring behind
 * media-match-audit-all and image-optimization-all — the id→data mapping and
 * the optional batched path were duplicated per definition before.
 */
export function scanFanoutTask<TData>({
	context,
	label,
	findIds,
	toData,
	enqueue,
	enqueueMany,
}: ScanFanoutInput<TData>): Promise<ScanAndEnqueueResult> {
	const options: Parameters<typeof scanAndEnqueueTask<string>>[0] = {
		context,
		findIds: (signal) => findIds(signal),
		enqueueItem: (id, schedulingOptions) => enqueue(toData(id), schedulingOptions),
		label,
	};
	if (enqueueMany) {
		const batched = enqueueMany;
		options.enqueueMany = (items, schedulingOptions) =>
			batched(
				items.map((item) => toData(item)),
				schedulingOptions,
			);
	}

	return scanAndEnqueueTask<string>(options);
}
