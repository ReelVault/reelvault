import { and, desc, eq, gte, lte, type SQL } from "drizzle-orm";
import { type DatabaseFactory, databaseFactory } from "@/database/database";
import { schema } from "@/database/schema";
import type { DatabaseTransaction } from "@/database/types";
import { CLIENT_IP_HEADER } from "@/utils/client-ip.utils";

const sensitiveKeyRegex = /(password|pin|token|secret|refresh.?token|access.?token|id.?token)/i;

export type AdminAuditAction = "create" | "update" | "delete";

export interface AdminAuditContext {
	actorUserId?: string | undefined;
	requestId?: string | undefined;
	headers?: Headers | undefined;
}

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

export class AdminAuditRepository {
	readonly table = schema.adminAuditLogs;
	private readonly database: Pick<DatabaseFactory, "getClient">;

	constructor(database: Pick<DatabaseFactory, "getClient"> = databaseFactory) {
		this.database = database;
	}

	async insert(record: AdminAuditRecord, tx?: DatabaseTransaction): Promise<void> {
		const context = record.context;
		await this.database
			.getClient({ tx })
			.insert(this.table)
			.values({
				actorUserId: context?.actorUserId ?? null,
				action: record.action,
				resourceType: record.resourceType,
				resourceId: record.resourceId ?? null,
				resourceName: record.resourceName ?? null,
				summary: record.summary ?? null,
				beforeJson: serializeAuditValue(record.before),
				afterJson: serializeAuditValue(record.after),
				requestId: context?.requestId ?? context?.headers?.get("x-request-id") ?? null,
				ipAddress: getClientIp(context?.headers),
				userAgent: context?.headers?.get("user-agent") ?? null,
			});
	}

	async findMany({
		page,
		limit,
		action,
		resourceType,
		actorUserId,
		ipAddress,
		requestId,
		from,
		to,
	}: {
		page: number;
		limit: number;
		action?: AdminAuditAction | undefined;
		resourceType?: string | undefined;
		actorUserId?: string | undefined;
		ipAddress?: string | undefined;
		requestId?: string | undefined;
		from?: string | undefined;
		to?: string | undefined;
	}) {
		const where: SQL[] = [];
		if (action) where.push(eq(this.table.action, action));

		if (resourceType) where.push(eq(this.table.resourceType, resourceType));

		if (actorUserId) where.push(eq(this.table.actorUserId, actorUserId));

		if (ipAddress) where.push(eq(this.table.ipAddress, ipAddress));

		if (requestId) where.push(eq(this.table.requestId, requestId));

		if (from) where.push(gte(this.table.createdAt, new Date(from)));

		if (to) where.push(lte(this.table.createdAt, new Date(to)));

		const condition = where.length > 0 ? and(...where) : undefined;
		const client = this.database.getClient();
		const [data, total] = await Promise.all([
			client
				.select()
				.from(this.table)
				.where(condition)
				.orderBy(desc(this.table.createdAt), desc(this.table.id))
				.limit(limit)
				.offset((page - 1) * limit),
			client.$count(this.table, condition),
		]);

		return { data, total };
	}
}

export function serializeAuditValue(value: unknown): string | null {
	if (value === undefined) return null;

	return JSON.stringify(redactAuditValue(value));
}

export function redactAuditValue(value: unknown, key?: string): unknown {
	if (key && isSensitiveKey(key)) return "[REDACTED]";

	if (Array.isArray(value)) return value.map((item) => redactAuditValue(item));

	if (value instanceof Date) return value;

	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redactAuditValue(entryValue, entryKey)]));
	}

	return value;
}

function isSensitiveKey(key: string): boolean {
	return sensitiveKeyRegex.test(key);
}

export function getClientIp(headers?: Headers): string | null {
	// Only the value stamped by clientIpMiddleware is trusted — X-Forwarded-For
	// and X-Real-IP are client-controlled unless a trusted proxy rewrote them,
	// and an audit trail with an attacker-chosen IP is worse than none.
	return headers?.get(CLIENT_IP_HEADER) ?? null;
}

export const adminAuditRepository = new AdminAuditRepository();
