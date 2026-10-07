import { withDomainError } from "@/application/context";
import { serverConfig } from "@/server.config";
import { errorMessage } from "@/utils/errors";
import { throwIfAborted } from "@/workers/utils/worker-cancellation";
import { workerService } from "@/workers/worker.service";
import { createWorkerDefinition, type WorkerEnqueueOptions } from "@/workers/worker.types";

// ─── Worker Definition ────────────────────────────────────────────────────────

export const downloadsProcessWorker = createWorkerDefinition<{ downloadId: string }>(
	"downloads-process",
	() => serverConfig.workers.definitions.downloadsProcess,
	({ data, logger, signal, updateProgress, attempt }) =>
		withDomainError(`Download processing failed: ${data.downloadId}`, async () => {
			throwIfAborted(signal);
			const { downloadsService } = await import("@/modules/downloads/downloads.service");
			try {
				await downloadsService.process(data.downloadId, {
					updateProgress: async (percent) => {
						if (updateProgress) await updateProgress(percent);
					},
					signal,
				});
			} catch (error) {
				// The pool retries a few times; only the final failure sticks — a
				// transient spawn/IO error must not kill the download early, but an
				// exhausted retry budget must not leave the row `pending` forever
				// (it would pin the profile's only active-download slot).
				const maxAttempts = downloadsProcessWorker.attempts ?? 3;
				if (attempt >= maxAttempts && !signal.aborted) {
					await downloadsService.markFailed(data.downloadId, errorMessage(error));
				}

				throw error;
			}

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
