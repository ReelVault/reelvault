import type { Logger } from "@reelvault/sdk/common";
import { recordAuditSafe } from "@/app/admin/admin-audit.service";
import type { AdminAuditContext } from "@/app/repositories/admin-audit.repository";
import { type MediaCleanupPlan, runMediaCleanup } from "./media-cleanup.cleaner";

export interface DeleteWithArtifactsParams {
	/** The artifact blobs and subtitle files the deleted row owned. */
	cleanup: MediaCleanupPlan;
	resourceType: string;
	resourceId: string;
	/** The snapshot of the row before it was deleted. */
	before: unknown;
	/** Refreshes the caches the deleted row was part of. */
	invalidate: () => void | Promise<void>;
	context: AdminAuditContext | undefined;
	logger: Logger;
}

/**
 * The tail every delete of an entity with artifacts shares: drop the artifact
 * blobs and subtitle files, refresh the caches the deleted row lived in, and
 * record the audit entry.
 *
 * The title, media file and library deletes each wrote the three steps out
 * again, and the order of the cache refresh and the audit record drifted apart
 * between them.
 */
export async function deleteWithArtifacts(params: DeleteWithArtifactsParams): Promise<void> {
	const { cleanup, resourceType, resourceId, before, invalidate, context, logger } = params;

	await runMediaCleanup(cleanup);
	await invalidate();

	recordAuditSafe({ action: "delete", resourceType, resourceId, before, context }, logger);
}
