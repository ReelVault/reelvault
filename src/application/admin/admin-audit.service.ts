import type { AdminAuditEntry, AdminAuditPage, FieldsQuery, Logger } from "@reelvault/sdk/common";
import {
	type AdminAuditAction,
	type AdminAuditContext,
	type AdminAuditRecord,
	adminAuditRepository,
} from "@/database/repositories/admin-audit.repository";
import { QueryPagination } from "@/database/utils/pagination";
import { BaseService } from "@/utils/base-service";
import { NotFoundError } from "@/utils/errors";
import { safeParseJson } from "@/utils/file.utils";
import { detach } from "@/utils/promise.utils";

class AdminAuditService extends BaseService {
	constructor() {
		super("AdminAuditService");
	}

	async record(record: AdminAuditRecord): Promise<void> {
		await adminAuditRepository.insert(record);
	}

	async getAll(query: {
		page?: number | undefined;
		limit?: number | undefined;
		action?: AdminAuditAction | undefined;
		resourceType?: string | undefined;
		actorUserId?: string | undefined;
		ipAddress?: string | undefined;
		requestId?: string | undefined;
		from?: string | undefined;
		to?: string | undefined;
	}): Promise<AdminAuditPage> {
		return await this.safeExecute("getAll", async () => {
			const pagination = QueryPagination.resolvePageParams(query, { defaultLimit: 50 });
			const result = await adminAuditRepository.findMany({ ...query, page: pagination.page, limit: pagination.limit });

			return {
				data: result.data.map(
					(entry) =>
						({
							id: entry.id,
							actorUserId: entry.actorUserId,
							action: entry.action,
							resourceType: entry.resourceType,
							resourceId: entry.resourceId,
							resourceName: entry.resourceName,
							summary: entry.summary,
							before: safeParseJson(entry.beforeJson),
							after: safeParseJson(entry.afterJson),
							requestId: entry.requestId,
							ipAddress: entry.ipAddress,
							userAgent: entry.userAgent,
							createdAt: entry.createdAt.toISOString(),
						}) satisfies AdminAuditEntry,
				),
				pagination: QueryPagination.buildAdminPagination({ total: result.total, page: pagination.page, limit: pagination.limit }),
			};
		});
	}
}

export const adminAuditService = new AdminAuditService();

interface AuditedUpdateParams<T> {
	logger: Logger;
	resourceType: string;
	resourceId: string;
	/** Entity label used in the not-found error (e.g. "Metadata"). */
	entityName: string;
	before: () => Promise<unknown>;
	update: () => Promise<T>;
	/** Runs after a successful update, before the audit record (etag invalidation, plugin events, sidecar sync). */
	afterUpdate?: (result: NonNullable<T>) => void | Promise<void>;
	context?: AdminAuditContext | undefined;
}

/**
 * Audited update skeleton: before-snapshot → update → not-found assert →
 * post-hooks → fire-and-forget audit record. The not-found assert mirrors
 * `BaseService.assertExists` (same `entity.not_found` error contract).
 */
export async function auditedUpdate<T>(params: AuditedUpdateParams<T>): Promise<NonNullable<T>> {
	const { logger, resourceType, resourceId, entityName } = params;
	const before = await params.before();
	const result = await params.update();
	if (result == null) {
		throw new NotFoundError(`${entityName} not found: ${resourceId}`, {
			code: "entity.not_found",
			params: { entityType: entityName, entityId: resourceId },
		});
	}

	await params.afterUpdate?.(result);

	recordAuditSafe(
		{
			action: "update",
			resourceType,
			resourceId,
			before,
			after: result,
			context: params.context,
		},
		logger,
	);

	return result;
}

/** Fire-and-forget audit log record — catches and logs errors instead of propagating. */
// TODO: Move to a service
export function recordAuditSafe(entry: AdminAuditRecord, logger: Logger): void {
	detach(
		(async () => {
			try {
				await adminAuditService.record(entry);
			} catch (error) {
				logger.warn("Audit log failed", { error });
			}
		})(),
	);
}

/**
 * Fields projection for an update's "before" audit snapshot: the fields being
 * written plus whatever the caller asked the "after" snapshot to contain.
 * Fetching the full relation graph just to JSON-serialize it into the audit log
 * cost 4-10 extra queries per admin edit; unchanged fields keep their values.
 */
export function auditBeforeFields<F extends string>(body: object, query?: FieldsQuery<F>): FieldsQuery {
	const parts = new Set<string>(["id"]);
	for (const key of Object.keys(body)) parts.add(key);

	for (const field of (query?.fields ?? "").split(",")) {
		const trimmed = field.trim();
		if (trimmed) parts.add(trimmed);
	}

	return { fields: [...parts].join(",") };
}
