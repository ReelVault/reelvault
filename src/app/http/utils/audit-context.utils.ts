import type { AdminAuditContext } from "@/app/repositories/admin-audit.repository";

/**
 * The audit context of the acting caller: who acts and with which headers.
 *
 * The routes build the same two-field object for every audited call; one
 * helper keeps the shape in one place.
 */
export function actorContext(context: { user?: { id: string } | null | undefined; request: Request }): AdminAuditContext {
	return { actorUserId: context.user?.id, headers: context.request.headers };
}
