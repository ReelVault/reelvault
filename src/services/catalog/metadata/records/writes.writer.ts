import type { CreateMetadata, FieldsQuery, MetadataWithRelation, SelectFields, UpdateMetadata } from "@reelvault/sdk/common";
import { sidecarSyncService } from "@/modules/metadata-sidecars/sidecar-sync.service";
import { metadataRepository } from "@/repositories/metadata.repository";
import { metadataMergeRepository } from "@/repositories/metadata-merge.repository";
import { auditBeforeFields, auditedUpdate, recordAuditSafe } from "@/services/admin/admin-audit.service";
import type { AdminAuditContext } from "@/services/admin/audit-context.types";
import { metadataLog } from "@/services/catalog/metadata/metadata.logger";
import { pluginEventBus } from "@/system/extensions/plugin.events";
import { assertFound, DomainError } from "@/utils/domain.errors";
import { runSafely } from "@/utils/safe-execute.utils";
import { invalidateReadCaches } from "./read-caches.utils";

export async function create<F extends string>(
	body: CreateMetadata,
	query?: FieldsQuery<F>,
	context?: AdminAuditContext,
): Promise<SelectFields<MetadataWithRelation, F>> {
	return await runSafely(metadataLog, "create", async () => {
		const result = await metadataRepository.createAndRead(body, query);
		if (!result) throw new DomainError("internal", "Metadata creation failed", { code: "metadata.create_failed" });

		invalidateReadCaches();
		pluginEventBus.publish("metadata.saved", { metadataId: result.id });

		recordAuditSafe(
			{
				action: "create",
				resourceType: "metadata",
				resourceId: result.id,
				after: result,
				context,
			},
			metadataLog.logger,
		);

		return result;
	});
}

export async function update<F extends string>(
	metadataId: string,
	body: UpdateMetadata,
	query?: FieldsQuery<F>,
	context?: AdminAuditContext,
): Promise<SelectFields<MetadataWithRelation, F>> {
	return await runSafely(metadataLog, "update", async () =>
		auditedUpdate({
			logger: metadataLog.logger,
			resourceType: "metadata",
			resourceId: metadataId,
			entityName: "Metadata",
			before: () => metadataRepository.findByIdForRead(metadataId, auditBeforeFields(body, query)),
			update: () => metadataRepository.updateAndRead(metadataId, body, query),
			afterUpdate: () => {
				invalidateReadCaches();
				pluginEventBus.publish("metadata.saved", { metadataId });
				// Keep sidecar documents in sync with the edit (sidecar storage modes).
				sidecarSyncService.scheduleSync(metadataId);
			},
			context,
		}),
	);
}

export async function mergeMetadata(
	targetId: string,
	sourceId: string,
	context?: AdminAuditContext,
): Promise<{ success: true; targetId: string }> {
	return await runSafely(metadataLog, "mergeMetadata", async () => {
		if (targetId === sourceId) {
			throw new DomainError("validation", "Target and source metadata must be different", {
				code: "metadata.merge_same_id",
				params: { metadataId: targetId },
			});
		}

		const [target, source] = await Promise.all([
			metadataRepository.findByIdForRead(targetId),
			metadataRepository.findByIdForRead(sourceId),
		]);
		assertFound(target, "Metadata (target)", targetId);
		assertFound(source, "Metadata (source)", sourceId);
		if (target.type !== source.type)
			throw new DomainError("validation", `Cannot merge metadata of different types (${target.type} vs ${source.type})`, {
				code: "metadata.merge_type_mismatch",
			});

		await metadataMergeRepository.merge(targetId, sourceId, target.type);
		invalidateReadCaches();
		// Media files were repointed to the target — rewrite its sidecars.
		sidecarSyncService.scheduleSync(targetId);

		recordAuditSafe(
			{
				action: "update",
				resourceType: "metadata_merge",
				resourceId: targetId,
				before: source,
				after: target,
				context,
			},
			metadataLog.logger,
		);

		return { success: true, targetId };
	});
}
