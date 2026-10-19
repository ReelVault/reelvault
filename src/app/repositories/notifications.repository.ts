import { and, desc, eq, gte, inArray, isNotNull, isNull, notInArray, or, type SQL, sql } from "drizzle-orm";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import type { DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import { forEachChunked } from "@/integrations/drizzle-orm/query/table-access/chunking.utils";
import { defineRepository, defineTableAccess } from "@/integrations/drizzle-orm/query/table-access/table-access.factory";
import { DomainError } from "@/utils/domain.errors";

const notifications = defineTableAccess("notifications", {
	primaryKeyColumn: "id",
});

/** Leaves out the notification types a profile has muted; no muted types means no condition at all. */
function excludedTypesWhere(excludedTypes: readonly string[]): SQL | undefined {
	return excludedTypes.length > 0 ? notInArray(schema.notifications.type, [...excludedTypes]) : undefined;
}

function recipientWhere(userId: string, profileId?: string): SQL | undefined {
	if (profileId) {
		return and(
			eq(schema.notifications.userId, userId),
			or(isNull(schema.notifications.profileId), eq(schema.notifications.profileId, profileId)),
		);
	}

	return and(eq(schema.notifications.userId, userId), isNull(schema.notifications.profileId));
}

/** Recipient filter shared by the list and page queries: owner, read state, type and muted types. */
function recipientConditions(input: {
	userId: string;
	profileId?: string | undefined;
	unreadOnly?: boolean | undefined;
	type?: string | undefined;
	excludedTypes?: readonly string[] | undefined;
}): SQL | undefined {
	return and(
		recipientWhere(input.userId, input.profileId),
		input.unreadOnly ? isNull(schema.notifications.readAt) : undefined,
		input.type ? eq(schema.notifications.type, input.type) : undefined,
		excludedTypesWhere(input.excludedTypes ?? []),
	);
}

/** Flips every matching notification to read (or unread), one state only. */
async function setAllRead(where: SQL | undefined, read: boolean): Promise<void> {
	const now = new Date();
	const stateFilter = read ? isNull(schema.notifications.readAt) : isNotNull(schema.notifications.readAt);
	await databaseFactory
		.getClient()
		.update(schema.notifications)
		.set({ readAt: read ? now : null, updatedAt: now })
		.where(and(where, stateFilter));
}

/** Deletes the listed rows that match the filter, in one transaction across chunks; returns how many were removed. */
async function deleteBatch(ids: string[], where: SQL | undefined): Promise<number> {
	if (ids.length === 0) return 0;

	let deleted = 0;
	await databaseFactory.transaction(async (tx) => {
		await forEachChunked(ids, async (idChunk) => {
			const rows = await tx
				.delete(schema.notifications)
				.where(and(inArray(schema.notifications.id, idChunk), where))
				.returning({ id: schema.notifications.id });
			deleted += rows.length;
		});
	});

	return deleted;
}

async function setBatchReadState(ids: string[], where: SQL | undefined, read: boolean): Promise<void> {
	if (ids.length === 0) return;

	const now = new Date();
	const readAt = read ? now : null;
	const stateFilter = read ? isNull(schema.notifications.readAt) : isNotNull(schema.notifications.readAt);
	// One transaction for all chunks — a mid-way failure must not leave half the
	// batch flipped.
	await databaseFactory.transaction(async (tx) => {
		await forEachChunked(ids, (idChunk) =>
			tx
				.update(schema.notifications)
				.set({ readAt, updatedAt: now })
				.where(and(inArray(schema.notifications.id, idChunk), where, stateFilter)),
		);
	});
}

const overrides = {
	async create(values: typeof schema.notifications.$inferInsert, tx?: DatabaseTransaction): Promise<string> {
		const [notification] = await notifications.insertReturning({ values, tx });
		if (!notification) throw new DomainError("internal", "Notification was not created", { code: "notifications.create_failed" });

		return notification.id;
	},

	async createBatch(items: Array<typeof schema.notifications.$inferInsert>, tx?: DatabaseTransaction): Promise<string[]> {
		if (items.length === 0) return [];

		const results = await notifications.insertReturning({ values: items, tx });

		return results.map((r) => r.id);
	},

	async findForRecipient(userId: string, profileId?: string, unreadOnly = false, limit = 50, excludedTypes: readonly string[] = []) {
		const where = recipientConditions({ userId, profileId, unreadOnly, excludedTypes });

		return await databaseFactory
			.getClient()
			.select()
			.from(notifications.table)
			.where(where)
			.orderBy(desc(notifications.table.createdAt))
			.limit(limit);
	},

	/** One page of the recipient's notifications, newest first, with the total of the same filter. */
	async findPageForRecipient({
		userId,
		profileId,
		unreadOnly,
		type,
		excludedTypes = [],
		limit,
		offset,
	}: {
		userId: string;
		profileId?: string | undefined;
		unreadOnly: boolean;
		type?: string | undefined;
		excludedTypes?: readonly string[] | undefined;
		limit: number;
		offset: number;
	}): Promise<{ data: Array<typeof schema.notifications.$inferSelect>; total: number }> {
		const where = recipientConditions({ userId, profileId, unreadOnly, type, excludedTypes });
		const client = databaseFactory.getClient();
		const [total, rows] = await Promise.all([
			client.$count(schema.notifications, where),
			client
				.select()
				.from(schema.notifications)
				.where(where)
				// created_at has second resolution — the id tiebreaker keeps offset pagination stable.
				.orderBy(desc(schema.notifications.createdAt), desc(schema.notifications.id))
				.limit(limit)
				.offset(offset),
		]);

		return { data: rows, total };
	},

	async countUnread(userId: string, profileId?: string, excludedTypes: readonly string[] = []): Promise<number> {
		const recipient = recipientWhere(userId, profileId);
		return await databaseFactory
			.getClient()
			.$count(notifications.table, and(recipient, isNull(notifications.table.readAt), excludedTypesWhere(excludedTypes)));
	},

	/** Daily-quota check for plugin notifications — notifications created by `pluginId` since `since`. */
	async countCreatedByPluginSince(pluginId: string, since: Date): Promise<number> {
		return await databaseFactory
			.getClient()
			.$count(notifications.table, and(eq(notifications.table.sourcePluginId, pluginId), gte(notifications.table.createdAt, since)));
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
			.select({ exists: sql`1` })
			.from(notifications.table)
			.where(and(...conditions))
			.limit(1);

		return result !== undefined;
	},

	async setRead(id: string, where: SQL | undefined, read: boolean): Promise<boolean> {
		const now = new Date();
		const result = await databaseFactory
			.getClient()
			.update(notifications.table)
			.set({ readAt: read ? now : null, updatedAt: now })
			.where(and(eq(notifications.table.id, id), where))
			.returning({ id: notifications.table.id });

		return result.length > 0;
	},

	async markReadForRecipient(id: string, userId: string, profileId?: string): Promise<boolean> {
		return await getNotificationsRepository().setRead(id, recipientWhere(userId, profileId), true);
	},

	async markUnreadForRecipient(id: string, userId: string, profileId?: string): Promise<boolean> {
		return await getNotificationsRepository().setRead(id, recipientWhere(userId, profileId), false);
	},

	async markReadBatch(ids: string[], userId: string, profileId?: string): Promise<void> {
		await setBatchReadState(ids, recipientWhere(userId, profileId), true);
	},

	async markUnreadBatch(ids: string[], userId: string, profileId?: string): Promise<void> {
		await setBatchReadState(ids, recipientWhere(userId, profileId), false);
	},

	/** Marks the recipient's notifications read; with `type`, only those of that type. */
	async markAllReadForRecipient(userId: string, profileId?: string, type?: string): Promise<void> {
		await setAllRead(and(recipientWhere(userId, profileId), type ? eq(schema.notifications.type, type) : undefined), true);
	},

	async markAllUnreadForRecipient(userId: string, profileId?: string, type?: string): Promise<void> {
		await setAllRead(and(recipientWhere(userId, profileId), type ? eq(schema.notifications.type, type) : undefined), false);
	},

	/** Deletes the given notifications of one recipient; ids that belong to someone else are left alone. */
	async deleteBatchForRecipient(ids: string[], userId: string, profileId?: string): Promise<number> {
		return await deleteBatch(ids, recipientWhere(userId, profileId));
	},
};

export const notificationsRepository = defineRepository(notifications, overrides);

/** Methods dispatch through the singleton: the lint rule forbids referencing the const before its definition. */
function getNotificationsRepository() {
	return notificationsRepository;
}
