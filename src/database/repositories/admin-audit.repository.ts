import { and, asc, count, desc, eq, gte, isNotNull, lt, lte, max, or, type SQL, sql } from "drizzle-orm";
import { type DatabaseFactory, databaseFactory } from "@/database/database";
import { schema } from "@/database/schema";
import { cachedCount } from "@/database/table-access";
import type { DatabaseTransaction } from "@/database/types";
import { QueryFiltering } from "@/database/utils/filtering";
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

/** Audit list filters shared by the service API and the repository query. */
export interface AdminAuditQuery {
	page?: number | undefined;
	limit?: number | undefined;
	action?: AdminAuditAction | undefined;
	resourceType?: string | undefined;
	actorUserId?: string | undefined;
	ipAddress?: string | undefined;
	requestId?: string | undefined;
	/** One term matched against the resource id and the summary. */
	q?: string | undefined;
	from?: string | undefined;
	to?: string | undefined;
}

/** The audit filters without paging: what the list and the summary have in common. */
export type AdminAuditFilters = Omit<AdminAuditQuery, "page" | "limit">;

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

	/** The filters that narrow the list and the per-administrator summary alike. */
	private conditionFor({ action, resourceType, actorUserId, ipAddress, requestId, q, from, to }: AdminAuditFilters): SQL | undefined {
		const where: SQL[] = [];
		if (action) where.push(eq(this.table.action, action));

		if (resourceType) where.push(eq(this.table.resourceType, resourceType));

		if (actorUserId) where.push(eq(this.table.actorUserId, actorUserId));

		if (ipAddress) where.push(eq(this.table.ipAddress, ipAddress));

		if (requestId) where.push(eq(this.table.requestId, requestId));

		if (q) {
			where.push(or(QueryFiltering.like(this.table.resourceId, q), QueryFiltering.like(this.table.summary, q)) ?? sql`1 = 0`);
		}

		if (from) where.push(gte(this.table.createdAt, new Date(from)));

		if (to) where.push(lte(this.table.createdAt, new Date(to)));

		return where.length > 0 ? and(...where) : undefined;
	}

	async findMany({ page, limit, ...filters }: AdminAuditQuery & { page: number; limit: number }) {
		const condition = this.conditionFor(filters);
		const client = this.database.getClient();
		const [data, total] = await Promise.all([
			client
				.select()
				.from(this.table)
				.where(condition)
				.orderBy(desc(this.table.createdAt), desc(this.table.id))
				.limit(limit)
				.offset((page - 1) * limit),
			cachedCount("admin_audit_logs", filters, async () => await this.database.getClient().$count(this.table, condition)),
		]);

		return { data, total };
	}

	/**
	 * Activity per administrator for the filters: totals per action and the latest entry, busiest
	 * first. Entries without an actor group under a null actor.
	 */
	async summarizeByActor(filters: AdminAuditFilters, limit: number) {
		const condition = this.conditionFor(filters);
		const client = this.database.getClient();
		const [total, actors] = await Promise.all([
			client.$count(this.table, condition),
			client
				.select({
					actorUserId: this.table.actorUserId,
					name: schema.users.name,
					total: count(),
					creates: sql<number>`coalesce(sum(case when ${this.table.action} = 'create' then 1 else 0 end), 0)`.mapWith(Number),
					updates: sql<number>`coalesce(sum(case when ${this.table.action} = 'update' then 1 else 0 end), 0)`.mapWith(Number),
					deletes: sql<number>`coalesce(sum(case when ${this.table.action} = 'delete' then 1 else 0 end), 0)`.mapWith(Number),
					lastAt: max(this.table.createdAt),
				})
				.from(this.table)
				.leftJoin(schema.users, eq(schema.users.id, this.table.actorUserId))
				.where(condition)
				.groupBy(this.table.actorUserId, schema.users.name)
				// Equal totals and timestamps (second resolution) fall back to the actor id, so the order is stable.
				.orderBy(desc(count()), desc(max(this.table.createdAt)), asc(this.table.actorUserId))
				.limit(limit),
		]);

		return { total, actors };
	}

	/**
	 * The resource types in the log and the administrators who wrote entries, for the audit filter dropdowns.
	 * Each list holds at most `limit` values; entries without an actor do not name an administrator.
	 */
	async findFilterOptions(limit: number) {
		const client = this.database.getClient();
		const [resourceRows, actorRows] = await Promise.all([
			client.selectDistinct({ resourceType: this.table.resourceType }).from(this.table).orderBy(asc(this.table.resourceType)).limit(limit),
			client
				.select({ actorUserId: this.table.actorUserId, name: schema.users.name })
				.from(this.table)
				.leftJoin(schema.users, eq(schema.users.id, this.table.actorUserId))
				.where(isNotNull(this.table.actorUserId))
				.groupBy(this.table.actorUserId, schema.users.name)
				// Named administrators come first, by name; accounts that no longer exist follow, by id.
				.orderBy(sql`${schema.users.name} is null`, asc(schema.users.name), asc(this.table.actorUserId))
				.limit(limit),
		]);

		return {
			resourceTypes: resourceRows.map((row) => row.resourceType),
			actors: actorRows.flatMap((row) => (row.actorUserId ? [{ actorUserId: row.actorUserId, name: row.name }] : [])),
		};
	}

	/** Deletes audit rows older than `cutoff` (daily retention sweep). */
	async pruneOlderThan(cutoff: Date): Promise<number> {
		const result = await this.database.getClient().delete(this.table).where(lt(this.table.createdAt, cutoff));

		return result.changes;
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
