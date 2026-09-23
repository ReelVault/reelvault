import type { PaginationQuery } from "@reelvault/sdk/common";
import { and, desc, eq, gt, ne } from "drizzle-orm";
import { databaseFactory } from "@/database/database";
import { schema } from "@/database/schema";
import { QueryPagination } from "@/database/utils/pagination";

class SessionsRepository {
	readonly table = schema.sessions;

	async findActivePageByUserId(userId: string, query?: PaginationQuery) {
		const pagination = QueryPagination.parse(query ?? {});
		const [total, data] = await Promise.all([
			this.countActiveByUserId(userId),
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
			.orderBy(desc(this.table.createdAt))
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

	async deleteAllForUser(userId: string): Promise<void> {
		await databaseFactory.getClient().delete(this.table).where(eq(this.table.userId, userId));
	}
}

export const sessionsRepository = new SessionsRepository();
