import type { PaginationQuery } from "@reelvault/sdk/common";
import { and, desc, eq, gt, inArray, ne, sql } from "drizzle-orm";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { QueryPagination } from "@/integrations/drizzle-orm/query/pagination.utils";
import { cachedCount } from "@/integrations/drizzle-orm/query/table-access/row-count.cache";

/** How a user's sessions have been used: the latest use, and how many sessions are still valid. */
export interface SessionActivity {
	lastActiveAt: Date | null;
	activeSessionCount: number;
}

class SessionsRepository {
	readonly table = schema.sessions;

	async findActivePageByUserId(userId: string, query?: PaginationQuery) {
		const pagination = QueryPagination.parse(query ?? {});
		// The count only depends on userId (expiry is a rolling window) — the 10 s
		// cache matches every other paginated list; sessions expire at minute scale.
		const [total, data] = await Promise.all([
			cachedCount("sessions_active", { userId }, () => this.countActiveByUserId(userId)),
			this.findActivePublicByUserId(userId, pagination.limit, pagination.offset),
		]);

		return QueryPagination.createResponse({ total, pagination, data });
	}

	async findActivePublicByUserId(userId: string, limit: number, offset: number) {
		const now = new Date();

		return await databaseFactory
			.getClient()
			.select({
				id: this.table.id,
				ipAddress: this.table.ipAddress,
				userAgent: this.table.userAgent,
				createdAt: this.table.createdAt,
				updatedAt: this.table.updatedAt,
				expiresAt: this.table.expiresAt,
			})
			.from(this.table)
			.where(and(eq(this.table.userId, userId), gt(this.table.expiresAt, now)))
			// created_at is second-resolution — the id tiebreaker keeps offset pages stable.
			.orderBy(desc(this.table.createdAt), desc(this.table.id))
			.limit(limit)
			.offset(offset);
	}

	async countActiveByUserId(userId: string): Promise<number> {
		return await databaseFactory.getClient().$count(this.table, and(eq(this.table.userId, userId), gt(this.table.expiresAt, new Date())));
	}

	async findTokenByIdAndUserId({ sessionId, userId }: { sessionId: string; userId: string }): Promise<string | undefined> {
		const [session] = await databaseFactory
			.getClient()
			.select({ token: this.table.token })
			.from(this.table)
			.where(and(eq(this.table.id, sessionId), eq(this.table.userId, userId)))
			.limit(1);

		return session?.token;
	}

	async deleteOtherSessions({ userId, currentSessionId }: { userId: string; currentSessionId: string }): Promise<void> {
		await databaseFactory
			.getClient()
			.delete(this.table)
			.where(and(eq(this.table.userId, userId), ne(this.table.id, currentSessionId)));
	}

	/** Activity per user in one query; users without sessions are absent from the map. */
	async findActivitySummaryByUserIds(userIds: readonly string[]): Promise<Map<string, SessionActivity>> {
		const summary = new Map<string, SessionActivity>();
		if (userIds.length === 0) return summary;

		const nowSeconds = Math.floor(Date.now() / 1000);
		const rows = await databaseFactory
			.getClient()
			.select({
				userId: this.table.userId,
				lastUsedSeconds: sql<number | null>`max(${this.table.updatedAt})`,
				activeSessionCount: sql<number>`sum(case when ${this.table.expiresAt} > ${nowSeconds} then 1 else 0 end)`,
			})
			.from(this.table)
			.where(inArray(this.table.userId, [...userIds]))
			.groupBy(this.table.userId);

		for (const row of rows) {
			summary.set(row.userId, {
				lastActiveAt: row.lastUsedSeconds === null ? null : new Date(row.lastUsedSeconds * 1000),
				activeSessionCount: row.activeSessionCount,
			});
		}

		return summary;
	}

	/** Ends one session of a user; false when the user has no such session. */
	async deleteForUser({ userId, sessionId }: { userId: string; sessionId: string }): Promise<boolean> {
		const deleted = await databaseFactory
			.getClient()
			.delete(this.table)
			.where(and(eq(this.table.id, sessionId), eq(this.table.userId, userId)))
			.returning({ id: this.table.id });

		return deleted.length > 0;
	}

	/** Ends every session of the listed users; returns how many were ended. */
	async deleteForUsers(userIds: readonly string[]): Promise<number> {
		if (userIds.length === 0) return 0;

		const deleted = await databaseFactory
			.getClient()
			.delete(this.table)
			.where(inArray(this.table.userId, [...userIds]))
			.returning({ id: this.table.id });

		return deleted.length;
	}

	async deleteAllForUser(userId: string): Promise<void> {
		await databaseFactory.getClient().delete(this.table).where(eq(this.table.userId, userId));
	}
}

export const sessionsRepository = new SessionsRepository();
