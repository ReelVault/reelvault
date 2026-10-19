import { serverConfig } from "@/config/server/server.config";
import { withDomainError } from "@/utils/domain.errors";
import { CATALOG_LIST_PATH_PREFIXES, invalidateResponseBodiesForPathPrefixes } from "@/utils/response-body.cache";
import type { ApplicationContext } from "@/utils/task-context.types";
import { defineWorkerEnqueue } from "@/workers/utils/worker-enqueue.utils";
import { workerDependencies } from "@/workers/worker.ports";
import { createWorkerDefinition } from "@/workers/worker.types";

export interface MetadataRefreshData {
	metadataId: string;
}

export interface MetadataRefreshResult {
	metadataId: string;
	providerId: string;
}

// ─── Worker Definition ────────────────────────────────────────────────────────

export const metadataRefreshWorker = createWorkerDefinition<MetadataRefreshData>(
	"metadata-refresh",
	() => serverConfig.workers.definitions.metadataRefresh,
	async ({ data, logger, signal, operationId, taskId }) =>
		await refreshMetadataTask(data, { signal, logger, operationId, correlationId: operationId, taskId }),
);

// ─── Task Function ────────────────────────────────────────────────────────────

export async function refreshMetadataTask(data: MetadataRefreshData, context: ApplicationContext = {}): Promise<MetadataRefreshResult> {
	return await withDomainError(`Metadata refresh failed: ${data.metadataId}`, async () => {
		context.signal?.throwIfAborted();

		const result = await workerDependencies().services.metadataRefresh.refresh(data.metadataId, {
			correlationId: context.correlationId,
			operationId: context.operationId,
			signal: context.signal,
		});
		// A refresh rewrites titles, credits and artwork the cached list responses embed.
		invalidateResponseBodiesForPathPrefixes(CATALOG_LIST_PATH_PREFIXES);

		return result;
	});
}

// ─── Enqueue Function ─────────────────────────────────────────────────────────

const metadataRefreshEnqueue = defineWorkerEnqueue<MetadataRefreshData>(metadataRefreshWorker.id, (data) => ({
	dedupeKey: data.metadataId,
	reference: { type: "metadata", id: data.metadataId },
}));

export const enqueueMetadataRefresh = metadataRefreshEnqueue.enqueue;

export const enqueueManyMetadataRefresh = metadataRefreshEnqueue.enqueueMany;
