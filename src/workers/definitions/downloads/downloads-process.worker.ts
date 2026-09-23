import { withDomainError } from "@/application/context";
import { serverConfig } from "@/server.config";
import { throwIfAborted } from "@/workers/utils/worker-cancellation";
import { workerService } from "@/workers/worker.service";
import { createWorkerDefinition, type WorkerEnqueueOptions } from "@/workers/worker.types";

// ─── Worker Definition ────────────────────────────────────────────────────────

export const downloadsProcessWorker = createWorkerDefinition<{ downloadId: string }>(
	"downloads-process",
	() => serverConfig.workers.definitions.downloadsProcess,
	({ data, logger, signal, updateProgress }) =>
		withDomainError(`Download processing failed: ${data.downloadId}`, async () => {
			throwIfAborted(signal);
			const { downloadsService } = await import("@/modules/downloads/downloads.service");
			await downloadsService.process(data.downloadId, {
				updateProgress: async (percent) => {
					if (updateProgress) await updateProgress(percent);
				},
				signal,
			});
			logger.info("Download processed", { downloadId: data.downloadId });
		}),
);

// ─── Enqueue Function ─────────────────────────────────────────────────────────

export function enqueueDownloadsProcess(downloadId: string, options: WorkerEnqueueOptions = {}) {
	return workerService.addItem(
		downloadsProcessWorker.id,
		{ downloadId },
		{
			...options,
			dedupeKey: downloadId,
			reference: { type: "download", id: downloadId },
		},
	);
}
