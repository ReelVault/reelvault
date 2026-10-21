import type { PaginationQuery } from "@reelvault/sdk/common";
import { and, desc, eq, gt, inArray, ne, sql } from "drizzle-orm";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { createPageResponse, parsePagination } from "@/integrations/drizzle-orm/query/pagination.utils";
import { findOffsetPage } from "@/integrations/drizzle-orm/query/table-access/reads.reader";

/** How a user's sessions have been used: the latest use, and how many sessions are still valid. */
export interface SessionActivity {
	lastActiveAt: Date | null;
	activeSessionCount: number;
}

export const sessionsRepository = {
	table: schema.sessions,

	async findActivePageByUserId(userId: string, query?: PaginationQuery) {
		const pagination = parsePagination(query ?? {});
		const where = and(eq(sessionsRepository.table.userId, userId), gt(sessionsRepository.table.expiresAt, new Date()));
		// The count only depends on userId (expiry is a rolling window) — the 10 s
		// cache matches every other paginated list; sessions expire at minute scale.
		const { data, total } = await findOffsetPage({
			access: { tableName: "sessions_active", primaryKeyColumn: sessionsRepository.table.id },
			where,
			orderBy: desc(sessionsRepository.table.createdAt),
			limit: pagination.limit,
			offset: pagination.offset,
			countKey: { userId },
			findMany: async (page) =>
				await databaseFactory
					.getClient()
					.select({
						id: sessionsRepository.table.id,
						ipAddress: sessionsRepository.table.ipAddress,
						userAgent: sessionsRepository.table.userAgent,
						createdAt: sessionsRepository.table.createdAt,
						updatedAt: sessionsRepository.table.updatedAt,
						expiresAt: sessionsRepository.table.expiresAt,
					})
					.from(sessionsRepository.table)
					.where(page.where)
					.orderBy(page.orderBy)
					.limit(page.limit)
					.offset(page.offset),
			count: () => sessionsRepository.countActiveByUserId(userId),
		});

		return createPageResponse({ total, pagination, data });
	},

	async countActiveByUserId(userId: string): Promise<number> {
		return await databaseFactory
			.getClient()
			.$count(
				sessionsRepository.table,
				and(eq(sessionsRepository.table.userId, userId), gt(sessionsRepository.table.expiresAt, new Date())),
			);
	},

	async findTokenByIdAndUserId({ sessionId, userId }: { sessionId: string; userId: string }): Promise<string | undefined> {
		const [session] = await databaseFactory
			.getClient()
			.select({ token: sessionsRepository.table.token })
			.from(sessionsRepository.table)
			.where(and(eq(sessionsRepository.table.id, sessionId), eq(sessionsRepository.table.userId, userId)))
			.limit(1);

		return session?.token;
	},

	async deleteOtherSessions({ userId, currentSessionId }: { userId: string; currentSessionId: string }): Promise<void> {
		await databaseFactory
			.getClient()
			.delete(sessionsRepository.table)
			.where(and(eq(sessionsRepository.table.userId, userId), ne(sessionsRepository.table.id, currentSessionId)));
	},

	/** Activity per user in one query; users without sessions are absent from the map. */
	async findActivitySummaryByUserIds(userIds: readonly string[]): Promise<Map<string, SessionActivity>> {
		const summary = new Map<string, SessionActivity>();
		if (userIds.length === 0) return summary;

		const nowSeconds = Math.floor(Date.now() / 1000);
		const rows = await databaseFactory
			.getClient()
			.select({
				userId: sessionsRepository.table.userId,
				lastUsedSeconds: sql<number | null>`max(${sessionsRepository.table.updatedAt})`,
				activeSessionCount: sql<number>`sum(case when ${sessionsRepository.table.expiresAt} > ${nowSeconds} then 1 else 0 end)`,
			})
			.from(sessionsRepository.table)
			.where(inArray(sessionsRepository.table.userId, [...userIds]))
			.groupBy(sessionsRepository.table.userId);

		for (const row of rows) {
			summary.set(row.userId, {
				lastActiveAt: row.lastUsedSeconds === null ? null : new Date(row.lastUsedSeconds * 1000),
				activeSessionCount: row.activeSessionCount,
			});
		}

		return summary;
	},

	/** Ends one session of a user; false when the user has no such session. */
	async deleteForUser({ userId, sessionId }: { userId: string; sessionId: string }): Promise<boolean> {
		const deleted = await databaseFactory
			.getClient()
			.delete(sessionsRepository.table)
			.where(and(eq(sessionsRepository.table.id, sessionId), eq(sessionsRepository.table.userId, userId)))
			.returning({ id: sessionsRepository.table.id });

		return deleted.length > 0;
	},

	/** Ends every session of the listed users; returns how many were ended. */
	async deleteForUsers(userIds: readonly string[]): Promise<number> {
		if (userIds.length === 0) return 0;

		const deleted = await databaseFactory
			.getClient()
			.delete(sessionsRepository.table)
			.where(inArray(sessionsRepository.table.userId, [...userIds]))
			.returning({ id: sessionsRepository.table.id });

		return deleted.length;
	},

	async deleteAllForUser(userId: string): Promise<void> {
		await databaseFactory.getClient().delete(sessionsRepository.table).where(eq(sessionsRepository.table.userId, userId));
	},
};
