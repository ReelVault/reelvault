import type { AdminAuditEntry, AdminAuditPage, AdminAuditSummary, FieldsQuery, Logger } from "@reelvault/sdk/common";
import {
	type AdminAuditContext,
	type AdminAuditFilters,
	type AdminAuditQuery,
	type AdminAuditRecord,
	type AdminAuditRepository,
	adminAuditRepository,
} from "@/database/repositories/admin-audit.repository";
import { QueryPagination } from "@/database/utils/pagination";
import { BaseService } from "@/utils/base-service";
import { toCsvLine } from "@/utils/csv.utils";
import { NotFoundError, ValidationError } from "@/utils/errors";
import { safeParseJson } from "@/utils/file.utils";
import { detach } from "@/utils/promise.utils";

/** Largest audit export; a wider one is refused, so an export never silently drops entries. */
export const AUDIT_EXPORT_MAX_ENTRIES = 10_000;

const AUDIT_CSV_HEADER =
	"id,createdAt,actorUserId,action,resourceType,resourceId,resourceName,summary,requestId,ipAddress,userAgent,before,after";

type AdminAuditRow = Awaited<ReturnType<AdminAuditRepository["findMany"]>>["data"][number];

function toAuditEntry(entry: AdminAuditRow): AdminAuditEntry {
	return {
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
	} satisfies AdminAuditEntry;
}

/** A snapshot cell: JSON text, or empty when the entry has none. */
function jsonCell(value: unknown): string {
	return value === undefined || value === null ? "" : JSON.stringify(value);
}

class AdminAuditService extends BaseService {
	constructor() {
		super("AdminAuditService");
	}

	async record(record: AdminAuditRecord): Promise<void> {
		await adminAuditRepository.insert(record);
	}

	/** Activity per administrator for the filters, busiest first; `limit` caps how many administrators are listed. */
	async getSummary(query: AdminAuditFilters & { limit?: number | undefined }): Promise<AdminAuditSummary> {
		return await this.safeExecute("getSummary", async () => {
			const { limit, ...filters } = query;
			const pagination = QueryPagination.resolvePageParams({ limit }, { defaultLimit: 20, maxLimit: 50 });
			const result = await adminAuditRepository.summarizeByActor(filters, pagination.limit);

			return {
				total: result.total,
				actors: result.actors.map((actor) => ({
					actorUserId: actor.actorUserId,
					name: actor.name,
					total: actor.total,
					creates: actor.creates,
					updates: actor.updates,
					deletes: actor.deletes,
					lastAt: actor.lastAt ? new Date(actor.lastAt).toISOString() : null,
				})),
			};
		});
	}

	async getAll(query: AdminAuditQuery): Promise<AdminAuditPage> {
		return await this.safeExecute("getAll", async () => {
			const pagination = QueryPagination.resolvePageParams(query, { defaultLimit: 50 });
			const result = await adminAuditRepository.findMany({ ...query, page: pagination.page, limit: pagination.limit });

			return {
				...QueryPagination.buildAdminPagination({ total: result.total, page: pagination.page, limit: pagination.limit }),
				data: result.data.map(toAuditEntry),
			};
		});
	}

	/** The entries matching the filters, as CSV or JSON Lines; an export past the cap is refused. */
	exportEntries(query: AdminAuditQuery & { format?: "csv" | "jsonl" | undefined }) {
		return this.safeExecute("exportEntries", async () => {
			const { format = "csv", ...filters } = query;
			const result = await adminAuditRepository.findMany({ ...filters, page: 1, limit: AUDIT_EXPORT_MAX_ENTRIES + 1 });
			if (result.data.length > AUDIT_EXPORT_MAX_ENTRIES) {
				throw new ValidationError(`The audit export holds at most ${AUDIT_EXPORT_MAX_ENTRIES} entries; narrow the filters`, {
					code: "admin.audit.export_too_large",
					params: { limit: AUDIT_EXPORT_MAX_ENTRIES },
				});
			}

			const entries = result.data.map(toAuditEntry);
			const filename = `audit-${new Date().toISOString().slice(0, 10)}.${format}`;
			if (format === "jsonl") {
				const lines = entries.map((entry) => JSON.stringify(entry));

				return {
					body: lines.length > 0 ? `${lines.join("\n")}\n` : "",
					contentType: "application/x-ndjson; charset=utf-8",
					filename,
				};
			}

			const rows = entries.map((entry) =>
				toCsvLine([
					entry.id,
					entry.createdAt,
					entry.actorUserId,
					entry.action,
					entry.resourceType,
					entry.resourceId,
					entry.resourceName,
					entry.summary,
					entry.requestId,
					entry.ipAddress,
					entry.userAgent,
					jsonCell(entry.before),
					jsonCell(entry.after),
				]),
			);

			return { body: `${[AUDIT_CSV_HEADER, ...rows].join("\n")}\n`, contentType: "text/csv; charset=utf-8", filename };
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

/**
 * Fire-and-forget audit log record — catches and logs errors instead of
 * propagating. Deliberately a free function taking the caller's logger: an
 * audit failure is attributed to the service that attempted the write, not to
 * AdminAuditService.
 */
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
