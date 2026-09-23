import { and, count, desc, eq, gte, inArray, isNull, or, type SQL } from "drizzle-orm";
import { databaseFactory } from "@/database/database";
import { schema } from "@/database/schema";
import { defineTableAccess, forEachChunked } from "@/database/table-access";
import type { DatabaseTransaction } from "@/database/types";
import { ConflictError } from "@/utils/errors";

const notifications = defineTableAccess("notifications", {
	primaryKeyColumn: "id",
});

class NotificationsRepository {
	readonly table = schema.notifications;
	readonly primaryKeyColumn = notifications.primaryKeyColumn;
	readonly query = notifications.query;
	readonly selectMany = notifications.selectMany;
	readonly selectFirst = notifications.selectFirst;
	readonly insert = notifications.insert;
	readonly insertReturning = notifications.insertReturning;
	readonly update = notifications.update;
	readonly updateReturning = notifications.updateReturning;
	readonly updateAndReturn = notifications.updateAndReturn;
	readonly delete = notifications.delete;
	readonly deleteReturning = notifications.deleteReturning;
	readonly deleteAndReturn = notifications.deleteAndReturn;
	readonly findByIds = notifications.findByIds;
	readonly findByColumnIn = notifications.findByColumnIn;

	async create(values: typeof schema.notifications.$inferInsert, tx?: DatabaseTransaction): Promise<string> {
		const [notification] = await notifications.insertReturning({ values, tx });
		if (!notification) throw new ConflictError("Notification was not created");

		return notification.id;
	}

	async createBatch(items: Array<typeof schema.notifications.$inferInsert>, tx?: DatabaseTransaction): Promise<string[]> {
		if (items.length === 0) return [];

		const results = await notifications.insertReturning({ values: items, tx });

		return results.map((r) => r.id);
	}

	async findForRecipient(userId: string, profileId?: string, unreadOnly = false, limit = 50) {
		const recipient = this.recipientWhere(userId, profileId);
		const where = unreadOnly ? and(recipient, isNull(this.table.readAt)) : recipient;

		return await databaseFactory.getClient().select().from(this.table).where(where).orderBy(desc(this.table.createdAt)).limit(limit);
	}

	async countUnread(userId: string, profileId?: string): Promise<number> {
		const recipient = this.recipientWhere(userId, profileId);
		const [result] = await databaseFactory
			.getClient()
			.select({ count: count() })
			.from(this.table)
			.where(and(recipient, isNull(this.table.readAt)));

		return result?.count ?? 0;
	}

	/** Daily-quota check for plugin notifications — notifications created by `pluginId` since `since`. */
	async countCreatedByPluginSince(pluginId: string, since: Date): Promise<number> {
		const [result] = await databaseFactory
			.getClient()
			.select({ count: count() })
			.from(this.table)
			.where(and(eq(this.table.sourcePluginId, pluginId), gte(this.table.createdAt, since)));

		return result?.count ?? 0;
	}

	async markRead(id: string, recipientWhere: SQL | undefined): Promise<boolean> {
		const result = await databaseFactory
			.getClient()
			.update(this.table)
			.set({ readAt: new Date(), updatedAt: new Date() })
			.where(and(eq(this.table.id, id), recipientWhere, isNull(this.table.readAt)))
			.returning({ id: this.table.id });

		return result.length > 0;
	}

	async markReadForRecipient(id: string, userId: string, profileId?: string): Promise<boolean> {
		return await this.markRead(id, this.recipientWhere(userId, profileId));
	}

	async markReadBatch(ids: string[], userId: string, profileId?: string): Promise<void> {
		if (ids.length === 0) return;

		const recipient = this.recipientWhere(userId, profileId);
		const now = new Date();
		await forEachChunked(ids, (idChunk) =>
			databaseFactory
				.getClient()
				.update(this.table)
				.set({ readAt: now, updatedAt: now })
				.where(and(inArray(this.table.id, idChunk), recipient, isNull(this.table.readAt))),
		);
	}

	async markAllReadForRecipient(userId: string, profileId?: string): Promise<void> {
		await this.markAllRead(this.recipientWhere(userId, profileId));
	}

	private async markAllRead(recipientWhere: SQL | undefined): Promise<void> {
		await databaseFactory
			.getClient()
			.update(this.table)
			.set({ readAt: new Date(), updatedAt: new Date() })
			.where(and(recipientWhere, isNull(this.table.readAt)));
	}

	private recipientWhere(userId: string, profileId?: string): SQL | undefined {
		if (profileId) {
			return and(eq(this.table.userId, userId), or(isNull(this.table.profileId), eq(this.table.profileId, profileId)));
		}

		return and(eq(this.table.userId, userId), isNull(this.table.profileId));
	}
}

export const notificationsRepository = new NotificationsRepository();
