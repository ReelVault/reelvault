import { metadataRefreshService } from "@/application/catalog/metadata/metadata-refresh.runtime";
import { type ApplicationContext, withDomainError } from "@/application/context";
import { serverConfig } from "@/server.config";
import { workerService } from "@/workers/worker.service";
import { createWorkerDefinition, type WorkerEnqueueOptions } from "@/workers/worker.types";

export interface MetadataRefreshData {
	metadataId: string;
}

export interface MetadataRefreshResult {
	metadataId: string;
	providerId: string;
}

export interface MetadataRefreshTaskDependencies {
	refresh(
		metadataId: string,
		options?: { correlationId?: string | undefined; operationId?: string | undefined; signal?: AbortSignal | undefined },
	): Promise<MetadataRefreshResult>;
}

const defaultDependencies: MetadataRefreshTaskDependencies = {
	refresh: async (metadataId, options) => {
		return await metadataRefreshService.refresh(metadataId, options);
	},
};

// ─── Worker Definition ────────────────────────────────────────────────────────

export const metadataRefreshWorker = createWorkerDefinition<MetadataRefreshData>(
	"metadata-refresh",
	() => serverConfig.workers.definitions.metadataRefresh,
	async ({ data, logger, signal, operationId, taskId }) =>
		await refreshMetadataTask(data, { signal, logger, operationId, correlationId: operationId, taskId }),
);

// ─── Task Function ────────────────────────────────────────────────────────────

export async function refreshMetadataTask(
	data: MetadataRefreshData,
	context: ApplicationContext = {},
	dependencies: MetadataRefreshTaskDependencies = defaultDependencies,
): Promise<MetadataRefreshResult> {
	return await withDomainError(`Metadata refresh failed: ${data.metadataId}`, async () => {
		context.signal?.throwIfAborted();

		return await dependencies.refresh(data.metadataId, {
			correlationId: context.correlationId,
			operationId: context.operationId,
			signal: context.signal,
		});
	});
}

// ─── Enqueue Function ─────────────────────────────────────────────────────────

export function enqueueMetadataRefresh(data: MetadataRefreshData, options: WorkerEnqueueOptions = {}) {
	return workerService.addItem(metadataRefreshWorker.id, data, {
		...options,
		dedupeKey: data.metadataId,
		reference: { type: "metadata", id: data.metadataId },
	});
}

export function enqueueManyMetadataRefresh(items: MetadataRefreshData[], options: WorkerEnqueueOptions = {}) {
	return workerService.addItems(
		metadataRefreshWorker.id,
		items.map((data) => ({
			data,
			options: {
				...options,
				dedupeKey: data.metadataId,
				reference: { type: "metadata", id: data.metadataId },
			},
		})),
	);
}
