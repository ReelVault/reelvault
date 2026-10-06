import { type ApplicationContext, withDomainError } from "@/application/context";
import { type ImageOptimizationOutcome, imageMaintenanceService } from "@/modules/images/image-maintenance.service";
import { MINUTE } from "@/server.constants";
import { scanAndEnqueueTask } from "@/workers/utils/scan-and-enqueue";
import { workerService } from "@/workers/worker.service";
import { createWorkerDefinition, type WorkerEnqueueOptions } from "@/workers/worker.types";

export interface ImageOptimizationData {
	imageId: string;
}

export interface ImageOptimizationResult {
	imageId: string;
	outcome: ImageOptimizationOutcome;
}

export interface ImageOptimizationScanResult {
	requested: number;
	queued: number;
}

// ─── Worker Definitions ───────────────────────────────────────────────────────

export const imageOptimizationWorker = createWorkerDefinition<ImageOptimizationData>(
	"image-optimization",
	() => ({
		category: "system",
		// 0 = auto: sharp-heavy job — concurrency derives from the image-processing
		// budget (WORKER_BUDGET_RATIO) instead of a static pool size.
		concurrency: 0,
		timeoutMs: MINUTE,
		attempts: 2,
		backoff: { type: "fixed", delayMs: 30_000 },
		removeOnComplete: 200,
		removeOnFail: 200,
	}),
	async ({ data, signal, operationId, taskId }) =>
		await processImageOptimizationTask({ imageId: data.imageId }, { signal, operationId, correlationId: operationId, taskId }),
);

export const imageOptimizationScanWorker = createWorkerDefinition<Record<string, never>>(
	"image-optimization-all",
	() => ({
		category: "system",
		concurrency: 1,
		timeoutMs: 10 * MINUTE,
	}),
	async ({ signal, logger, operationId, taskId }) =>
		await scanImagesForOptimizationTask({ signal, logger, operationId, correlationId: operationId, taskId }),
);

// ─── Task Functions ───────────────────────────────────────────────────────────

export function processImageOptimizationTask(
	data: ImageOptimizationData,
	context: ApplicationContext = {},
): Promise<ImageOptimizationResult> {
	return withDomainError(`Image optimization failed: ${data.imageId}`, async () => {
		context.signal?.throwIfAborted();
		if (!data.imageId) throw new Error("Image optimization task requires an imageId");

		const outcome = await imageMaintenanceService.optimizeImageById(data.imageId, context.signal);

		return { imageId: data.imageId, outcome };
	});
}

export function scanImagesForOptimizationTask(context: ApplicationContext = {}): Promise<ImageOptimizationScanResult> {
	return withDomainError("Image optimization scan failed", () =>
		scanAndEnqueueTask<string, ImageOptimizationData>({
			context,
			label: "Image optimizations queued",
			findIds: (signal) => imageMaintenanceService.findOutdatedImageIds(signal),
			toData: (imageId) => ({ imageId }),
			enqueueItem: (data, options) => enqueueImageOptimization(data, options),
			enqueueMany: (items, options) => enqueueImageOptimizationMany(items, options),
		}),
	);
}

/** Batched variant of {@link enqueueImageOptimization} — one INSERT batch instead of one per image. */
function enqueueImageOptimizationMany(items: ImageOptimizationData[], options: WorkerEnqueueOptions) {
	return workerService.addItems(
		imageOptimizationWorker.id,
		items.map((data) => ({
			data,
			options: {
				...options,
				dedupeKey: `image-optimization:${data.imageId}`,
				reference: { type: "image", id: data.imageId },
				priority: 50,
			},
		})),
	);
}

// ─── Enqueue Functions ────────────────────────────────────────────────────────

export function enqueueImageOptimization(data: ImageOptimizationData, options: WorkerEnqueueOptions = {}) {
	return workerService.addItem(imageOptimizationWorker.id, data, {
		...options,
		dedupeKey: `image-optimization:${data.imageId}`,
		reference: { type: "image", id: data.imageId },
		priority: 50,
	});
}
