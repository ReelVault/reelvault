import { recordAuditSafe } from "@/application/admin/admin-audit.service";
import type { AdminAuditContext } from "@/database/repositories/admin-audit.repository";
import { metadataRepository } from "@/database/repositories/metadata.repository";
import { ValidationError } from "@/utils/errors";
import { createLogger } from "@/utils/logger";
import { enqueueManyMetadataRefresh, enqueueMetadataRefresh } from "@/workers/definitions/metadata/metadata-refresh.worker";
import { enqueueDeduped } from "@/workers/utils/enqueue-deduped";
import { workerService } from "@/workers/worker.service";

const logger = createLogger("MetadataRefreshQueueService");

/** Ids enqueued per transaction for the "refresh all" sweep. */
const METADATA_REFRESH_ENQUEUE_PAGE_SIZE = 500;

/** Upper bound for an explicit metadataIds batch — the admin filter subset. */
const METADATA_REFRESH_BATCH_LIMIT = 5000;

export interface MetadataRefreshQueueInput {
	metadataId?: string | undefined;
	metadataIds?: string[] | undefined;
}

class MetadataRefreshQueueService {
	async queue(input: MetadataRefreshQueueInput, context: AdminAuditContext): Promise<{ operationId: string } | undefined> {
		if (input.metadataIds) {
			return await this.queueBatch(input.metadataIds, context);
		}

		if (input.metadataId) {
			const metadataId = input.metadataId;
			const enqueued = await enqueueDeduped({
				targets: [{ workerId: "metadata-refresh", dedupeKey: metadataId }],
				type: "metadata-refresh",
				reference: { type: "metadata", id: metadataId },
				label: "metadata refresh",
				enqueue: (operationId) => enqueueMetadataRefresh({ metadataId }, { operationId }),
			});
			recordAuditSafe(
				{
					action: "create",
					resourceType: "metadata_refresh",
					resourceId: metadataId,
					after: { metadataId, operationId: enqueued.operationId, status: "pending" },
					context,
				},
				logger,
			);

			return { operationId: enqueued.operationId };
		}

		// Keyset-page the catalog and enqueue one batch at a time: the previous
		// version loaded every id and inserted them in a single transaction, which
		// held the SQLite write lock and allocated hundreds of MB on large libraries.
		const { operationId, result: count } = await workerService.enqueueUnderOperation(
			{ type: "metadata-refresh-all", reference: { type: "metadata-all", id: "all" } },
			async (opId) => {
				let cursor: string | undefined;
				let enqueued = 0;
				for (;;) {
					const rows = await metadataRepository.findIdsPage(cursor, METADATA_REFRESH_ENQUEUE_PAGE_SIZE);
					if (rows.length === 0) break;

					await enqueueManyMetadataRefresh(
						rows.map(({ id }) => ({ metadataId: id })),
						{ operationId: opId },
					);
					enqueued += rows.length;
					if (rows.length < METADATA_REFRESH_ENQUEUE_PAGE_SIZE) break;

					cursor = rows.at(-1)?.id;
					if (!cursor) break;
				}

				if (enqueued === 0) {
					throw new ValidationError("No metadata to refresh", { code: "admin.metadata.refresh_empty" });
				}

				return enqueued;
			},
		);

		recordAuditSafe(
			{
				action: "create",
				resourceType: "metadata_refresh_all",
				resourceId: "all",
				after: { count, operationId, status: "pending" },
				context,
			},
			logger,
		);

		return { operationId: operationId };
	}

	/** Explicit id subset (e.g. the missing-translation admin filter) — one operation, deduped ids, page-sized inserts. */
	private async queueBatch(metadataIds: string[], context: AdminAuditContext): Promise<{ operationId: string }> {
		const ids = [...new Set(metadataIds.map((id) => id.trim()).filter((id) => id.length > 0))];
		if (ids.length === 0) {
			throw new ValidationError("No metadata ids to refresh", { code: "admin.metadata.refresh_empty" });
		}

		if (ids.length > METADATA_REFRESH_BATCH_LIMIT) {
			throw new ValidationError(`Too many metadata ids (max ${METADATA_REFRESH_BATCH_LIMIT})`, {
				code: "admin.metadata.refresh_batch_too_large",
			});
		}

		const { operationId } = await workerService.enqueueUnderOperation(
			{ type: "metadata-refresh-all", reference: { type: "metadata-all", id: "batch" } },
			async (opId) => {
				let enqueued = 0;
				for (let offset = 0; offset < ids.length; offset += METADATA_REFRESH_ENQUEUE_PAGE_SIZE) {
					const page = ids.slice(offset, offset + METADATA_REFRESH_ENQUEUE_PAGE_SIZE);
					await enqueueManyMetadataRefresh(
						page.map((metadataId) => ({ metadataId })),
						{ operationId: opId },
					);
					enqueued += page.length;
				}

				return enqueued;
			},
		);

		recordAuditSafe(
			{
				action: "create",
				resourceType: "metadata_refresh_batch",
				resourceId: "batch",
				after: { count: ids.length, operationId, status: "pending" },
				context,
			},
			logger,
		);

		return { operationId };
	}
}

export const metadataRefreshQueueService = new MetadataRefreshQueueService();
