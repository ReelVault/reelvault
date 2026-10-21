import type { AdminAuditAction } from "@/repositories/admin-audit.repository";

/**
 * The audit context of the acting caller: who acts and with which headers.
 *
 * The headers travel with the context so the audit service can resolve the
 * client IP and the request id once, in one place.
 */
export interface AdminAuditContext {
	actorUserId?: string | undefined;
	requestId?: string | undefined;
	headers?: Headers | undefined;
}

/** One audited change: what happened, to what, and the context of the caller. */
export interface AdminAuditRecord {
	action: AdminAuditAction;
	resourceType: string;
	resourceId?: string | null | undefined;
	resourceName?: string | null | undefined;
	summary?: string | null | undefined;
	before?: unknown;
	after?: unknown;
	context?: AdminAuditContext | undefined;
}
