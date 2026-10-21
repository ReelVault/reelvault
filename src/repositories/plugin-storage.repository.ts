import { and, asc, eq, gt, inArray, isNull, lte, or, sum } from "drizzle-orm";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import type { DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import { filterStartsWith } from "@/integrations/drizzle-orm/query/parsing/filtering.parser";
import { defineTableAccess } from "@/integrations/drizzle-orm/query/table-access/table-access.factory";

const pluginStorage = defineTableAccess("pluginStorage", { primaryKeyColumn: "pluginId" });
const pluginBlobs = defineTableAccess("pluginBlobs", { primaryKeyColumn: "pluginId" });

export const pluginStorageRepository = {
	table: schema.pluginStorage,

	async find(pluginId: string, key: string): Promise<string | undefined> {
		const [entry] = await databaseFactory
			.getClient()
			.select({ value: pluginStorageRepository.table.value })
			.from(pluginStorageRepository.table)
			.where(and(eq(pluginStorageRepository.table.pluginId, pluginId), eq(pluginStorageRepository.table.key, key)))
			.limit(1);

		return entry?.value;
	},

	async set(pluginId: string, key: string, value: string): Promise<void> {
		await pluginStorage.upsert({
			values: { pluginId, key, value },
			target: [pluginStorage.table.pluginId, pluginStorage.table.key],
			set: { value, updatedAt: new Date() },
		});
	},

	async delete(pluginId: string, key: string): Promise<void> {
		await databaseFactory
			.getClient()
			.delete(pluginStorageRepository.table)
			.where(and(eq(pluginStorageRepository.table.pluginId, pluginId), eq(pluginStorageRepository.table.key, key)));
	},

	async deleteForPlugin(pluginId: string): Promise<void> {
		await databaseFactory.getClient().delete(pluginStorageRepository.table).where(eq(pluginStorageRepository.table.pluginId, pluginId));
	},

	/**
	 * The keys of one plugin, optionally narrowed to a prefix and capped — the
	 * filter and the limit belong in the query, so a plugin with a large store
	 * does not materialize every key to hand back the first page of them.
	 */
	async findKeysByPlugin(pluginId: string, options?: { prefix?: string | undefined; limit?: number | undefined }): Promise<string[]> {
		const rows = await databaseFactory
			.getClient()
			.select({ key: pluginStorageRepository.table.key })
			.from(pluginStorageRepository.table)
			.where(
				and(
					eq(pluginStorageRepository.table.pluginId, pluginId),
					options?.prefix ? filterStartsWith(pluginStorageRepository.table.key, options.prefix) : undefined,
				),
			)
			.orderBy(asc(pluginStorageRepository.table.key))
			.limit(options?.limit ?? -1);

		return rows.map((row) => row.key);
	},
};

export const pluginBlobsRepository = {
	table: schema.pluginBlobs,

	async find(pluginId: string, key: string, tx?: DatabaseTransaction) {
		const [entry] = await databaseFactory
			.getClient({ tx })
			.select()
			.from(pluginBlobsRepository.table)
			.where(and(eq(pluginBlobsRepository.table.pluginId, pluginId), eq(pluginBlobsRepository.table.key, key)))
			.limit(1);

		return entry;
	},

	async findByPlugin(pluginId: string, options?: { tx?: DatabaseTransaction | undefined; afterKey?: string | undefined; limit?: number }) {
		const conditions = [eq(pluginBlobsRepository.table.pluginId, pluginId)];
		if (options?.afterKey) conditions.push(gt(pluginBlobsRepository.table.key, options.afterKey));

		const query = databaseFactory
			.getClient({ tx: options?.tx })
			.select()
			.from(pluginBlobsRepository.table)
			.where(and(...conditions))
			.orderBy(asc(pluginBlobsRepository.table.key));

		if (options?.limit === undefined) return await query;

		return await query.limit(options.limit);
	},

	async deleteByKeys(pluginId: string, keys: string[]): Promise<void> {
		if (keys.length === 0) return;

		await databaseFactory
			.getClient()
			.delete(pluginBlobsRepository.table)
			.where(and(eq(pluginBlobsRepository.table.pluginId, pluginId), inArray(pluginBlobsRepository.table.key, keys)));
	},

	async sumSizeByPlugin(pluginId: string, tx?: DatabaseTransaction): Promise<number> {
		// Expired blobs are purged lazily (purgeExpired) — they must not count
		// against the quota while they still exist on disk only nominally.
		const now = new Date();
		const [result] = await databaseFactory
			.getClient({ tx })
			.select({ totalSize: sum(pluginBlobsRepository.table.size) })
			.from(pluginBlobsRepository.table)
			.where(
				and(
					eq(pluginBlobsRepository.table.pluginId, pluginId),
					or(isNull(pluginBlobsRepository.table.expiresAt), gt(pluginBlobsRepository.table.expiresAt, now)),
				),
			);

		return Number(result?.totalSize ?? 0);
	},

	async findExpired(now: Date, limit?: number) {
		const query = databaseFactory
			.getClient()
			.select()
			.from(pluginBlobsRepository.table)
			.where(lte(pluginBlobsRepository.table.expiresAt, now))
			.orderBy(asc(pluginBlobsRepository.table.expiresAt));

		if (limit === undefined) return await query;

		return await query.limit(limit);
	},

	async set(values: typeof schema.pluginBlobs.$inferInsert, tx?: DatabaseTransaction): Promise<void> {
		await pluginBlobs.upsert({
			values,
			target: [pluginBlobs.table.pluginId, pluginBlobs.table.key],
			set: {
				storageKey: values.storageKey,
				contentType: values.contentType,
				size: values.size,
				expiresAt: values.expiresAt,
				createdAt: values.createdAt,
				updatedAt: new Date(),
			},
			tx,
		});
	},

	async delete(pluginId: string, key: string, tx?: DatabaseTransaction): Promise<void> {
		await databaseFactory
			.getClient({ tx })
			.delete(pluginBlobsRepository.table)
			.where(and(eq(pluginBlobsRepository.table.pluginId, pluginId), eq(pluginBlobsRepository.table.key, key)));
	},
};
