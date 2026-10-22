import type { AdminAuditChange } from "@/repositories/admin-audit.repository";

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

/** One audited change with the context of the caller. */
export interface AdminAuditRecord extends AdminAuditChange {
	context?: AdminAuditContext | undefined;
}
