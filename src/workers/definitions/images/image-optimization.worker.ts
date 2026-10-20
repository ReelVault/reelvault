import { MINUTE } from "@/config/server/server.constants";
import { type ImageOptimizationOutcome, imageMaintenanceService } from "@/modules/images/image-maintenance.service";
import { DomainError, withDomainError } from "@/utils/domain.errors";
import type { ApplicationContext } from "@/utils/task-context.types";
import { scanAndEnqueueTask } from "@/workers/utils/scan-and-enqueue.service";
import { toApplicationContext } from "@/workers/utils/task-context.mapper";
import { defineWorkerEnqueue } from "@/workers/utils/worker-enqueue.utils";
import { createWorkerDefinition } from "@/workers/worker.types";

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
	async (context) => await processImageOptimizationTask({ imageId: context.data.imageId }, toApplicationContext(context)),
);

export const imageOptimizationScanWorker = createWorkerDefinition<Record<string, never>>(
	"image-optimization-all",
	() => ({
		category: "system",
		concurrency: 1,
		timeoutMs: 10 * MINUTE,
	}),
	async (context) => await scanImagesForOptimizationTask(toApplicationContext(context)),
);

// ─── Task Functions ───────────────────────────────────────────────────────────

export function processImageOptimizationTask(
	data: ImageOptimizationData,
	context: ApplicationContext = {},
): Promise<ImageOptimizationResult> {
	return withDomainError(`Image optimization failed: ${data.imageId}`, async () => {
		context.signal?.throwIfAborted();
		if (!data.imageId)
			throw new DomainError("internal", "Image optimization task requires an imageId", { code: "workers.image_optimization_id_missing" });

		const outcome = await imageMaintenanceService.optimizeImageById(data.imageId, context.signal);

		return { imageId: data.imageId, outcome };
	});
}

// ─── Enqueue Functions ────────────────────────────────────────────────────────

const imageOptimizationEnqueue = defineWorkerEnqueue<ImageOptimizationData>(imageOptimizationWorker.id, (data) => ({
	dedupeKey: `image-optimization:${data.imageId}`,
	reference: { type: "image", id: data.imageId },
	priority: 50,
}));

export const enqueueImageOptimization = imageOptimizationEnqueue.enqueue;

/** Batched variant of {@link enqueueImageOptimization} — one INSERT batch instead of one per image. */
const enqueueImageOptimizationMany = imageOptimizationEnqueue.enqueueMany;

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
