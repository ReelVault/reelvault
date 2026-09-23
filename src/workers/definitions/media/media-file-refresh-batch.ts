import type { TaskSchedulingOptions } from "@/application/context";
import type { WorkerItem } from "@/database/repositories/worker.repository";
import { chunk } from "@/utils/array.utils";
import { ConflictError } from "@/utils/errors";
import { ENQUEUE_BATCH_SIZE } from "@/workers/worker.constants";
import { workerService } from "@/workers/worker.service";
import { metadataRefreshWorker } from "../metadata/metadata-refresh.worker";
import { mediaFileTechnicalRefreshWorker } from "./media-file-technical-refresh.worker";

export interface MediaFileRefreshTarget {
	id: string;
	metadataId: string;
}

/**
 * Enqueues technical + metadata refreshes for many media files in batched
 * INSERTs instead of two INSERTs per file. Deduplication and the
 * "active task must belong to the same operation" rule match the single-file
 * refresh operation.
 */
export async function enqueueMediaFileRefreshBatch(
	targets: readonly MediaFileRefreshTarget[],
	options: TaskSchedulingOptions = {},
): Promise<void> {
	if (targets.length === 0) return;

	// Validate operation compatibility BEFORE inserting anything: a conflicting
	// active task would otherwise surface only after earlier chunks were inserted,
	// leaving a partial enqueue behind.
	if (options.operationId) {
		const existingTechnical = await workerService.findActiveItems(
			mediaFileTechnicalRefreshWorker.id,
			targets.map(({ id }) => id),
		);
		assertSameOperation(existingTechnical, options.operationId, "technical media refresh");
		const existingMetadata = await workerService.findActiveItems(
			metadataRefreshWorker.id,
			targets.map(({ metadataId }) => metadataId),
		);
		assertSameOperation(existingMetadata, options.operationId, "metadata refresh");
	}

	// Phase 1: technical refreshes, deduplicated per media file.
	const technicalItems: WorkerItem[] = [];
	for (const targetChunk of chunk(targets, ENQUEUE_BATCH_SIZE)) {
		technicalItems.push(
			...(await workerService.addItems(
				mediaFileTechnicalRefreshWorker.id,
				targetChunk.map(({ id }) => ({
					data: { mediaFileId: id },
					options: { ...options, dedupeKey: id, reference: { type: "media-file", id } },
				})),
			)),
		);
	}

	assertSameOperation(technicalItems, options.operationId, "technical media refresh");

	const technicalIdByMediaFileId = new Map<string, string>();
	for (const item of technicalItems) {
		if (item.referenceId) technicalIdByMediaFileId.set(item.referenceId, item.id);
	}

	// Phase 2: metadata refreshes chained onto their technical task.
	for (const targetChunk of chunk(targets, ENQUEUE_BATCH_SIZE)) {
		const metadataItems = await workerService.addItems(
			metadataRefreshWorker.id,
			targetChunk.map(({ id, metadataId }) => ({
				data: { metadataId },
				options: {
					...options,
					dedupeKey: metadataId,
					reference: { type: "metadata", id: metadataId },
					dependsOnJobId: technicalIdByMediaFileId.get(id),
				},
			})),
		);
		assertSameOperation(metadataItems, options.operationId, "metadata refresh");
	}
}

/** Reproduces the single-file refresh operation's operation-compatibility check. */
function assertSameOperation(items: ReadonlyArray<{ operationId: string | null }>, operationId: string | undefined, label: string): void {
	if (!operationId) return;

	for (const item of items) {
		if (item.operationId && item.operationId !== operationId) {
			throw new ConflictError(`Active ${label} belongs to another operation`);
		}
	}
}
