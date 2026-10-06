import { and, count, desc, eq, gte, inArray, isNull, or, type SQL, sql } from "drizzle-orm";
import { databaseFactory } from "@/database/database";
import { schema } from "@/database/schema";
import { defineRepository, defineTableAccess, forEachChunked } from "@/database/table-access";
import type { DatabaseTransaction } from "@/database/types";
import { ConflictError } from "@/utils/errors";

const notifications = defineTableAccess("notifications", {
	primaryKeyColumn: "id",
});

function recipientWhere(userId: string, profileId?: string): SQL | undefined {
	if (profileId) {
		return and(
			eq(schema.notifications.userId, userId),
			or(isNull(schema.notifications.profileId), eq(schema.notifications.profileId, profileId)),
		);
	}

	return and(eq(schema.notifications.userId, userId), isNull(schema.notifications.profileId));
}

const markAllRead = async (where: SQL | undefined): Promise<void> => {
	await databaseFactory
		.getClient()
		.update(schema.notifications)
		.set({ readAt: new Date(), updatedAt: new Date() })
		.where(and(where, isNull(schema.notifications.readAt)));
};

const overrides = {
	async create(values: typeof schema.notifications.$inferInsert, tx?: DatabaseTransaction): Promise<string> {
		const [notification] = await notifications.insertReturning({ values, tx });
		if (!notification) throw new ConflictError("Notification was not created");

		return notification.id;
	},

	async createBatch(items: Array<typeof schema.notifications.$inferInsert>, tx?: DatabaseTransaction): Promise<string[]> {
		if (items.length === 0) return [];

		const results = await notifications.insertReturning({ values: items, tx });

		return results.map((r) => r.id);
	},

	async findForRecipient(userId: string, profileId?: string, unreadOnly = false, limit = 50) {
		const recipient = recipientWhere(userId, profileId);
		const where = unreadOnly ? and(recipient, isNull(notifications.table.readAt)) : recipient;

		return await databaseFactory
			.getClient()
			.select()
			.from(notifications.table)
			.where(where)
			.orderBy(desc(notifications.table.createdAt))
			.limit(limit);
	},

	async countUnread(userId: string, profileId?: string): Promise<number> {
		const recipient = recipientWhere(userId, profileId);
		const [result] = await databaseFactory
			.getClient()
			.select({ count: count() })
			.from(notifications.table)
			.where(and(recipient, isNull(notifications.table.readAt)));

		return result?.count ?? 0;
	},

	/** Daily-quota check for plugin notifications — notifications created by `pluginId` since `since`. */
	async countCreatedByPluginSince(pluginId: string, since: Date): Promise<number> {
		const [result] = await databaseFactory
			.getClient()
			.select({ count: count() })
			.from(notifications.table)
			.where(and(eq(notifications.table.sourcePluginId, pluginId), gte(notifications.table.createdAt, since)));

		return result?.count ?? 0;
	},

	/** De-duplication for system notifications carrying `version`/`component` inside their data payload. */
	async existsForVersion(type: string, version: string, component?: string): Promise<boolean> {
		const conditions = [
			eq(notifications.table.type, type),
			sql`json_extract(${notifications.table.data}, '$.version') = ${version}`,
			...(component ? [sql`json_extract(${notifications.table.data}, '$.component') = ${component}`] : []),
		];
		const [result] = await databaseFactory
			.getClient()
			.select({ count: count() })
			.from(notifications.table)
			.where(and(...conditions));

		return (result?.count ?? 0) > 0;
	},

	async markRead(id: string, where: SQL | undefined): Promise<boolean> {
		const result = await databaseFactory
			.getClient()
			.update(notifications.table)
			.set({ readAt: new Date(), updatedAt: new Date() })
			.where(and(eq(notifications.table.id, id), where, isNull(notifications.table.readAt)))
			.returning({ id: notifications.table.id });

		return result.length > 0;
	},

	async markReadForRecipient(id: string, userId: string, profileId?: string): Promise<boolean> {
		return await getNotificationsRepository().markRead(id, recipientWhere(userId, profileId));
	},

	async markReadBatch(ids: string[], userId: string, profileId?: string): Promise<void> {
		if (ids.length === 0) return;

		const recipient = recipientWhere(userId, profileId);
		const now = new Date();
		await forEachChunked(ids, (idChunk) =>
			databaseFactory
				.getClient()
				.update(notifications.table)
				.set({ readAt: now, updatedAt: now })
				.where(and(inArray(notifications.table.id, idChunk), recipient, isNull(notifications.table.readAt))),
		);
	},

	async markAllReadForRecipient(userId: string, profileId?: string): Promise<void> {
		await markAllRead(recipientWhere(userId, profileId));
	},
};

export const notificationsRepository = defineRepository(notifications, overrides);

/** Methods dispatch through the singleton so tests can monkey-patch delegations. */
function getNotificationsRepository() {
	return notificationsRepository;
}
