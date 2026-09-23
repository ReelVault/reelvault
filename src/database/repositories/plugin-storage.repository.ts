import { and, asc, eq, gt, inArray, isNull, lte, or, sum } from "drizzle-orm";
import { databaseFactory } from "@/database/database";
import { schema } from "@/database/schema";
import type { DatabaseTransaction } from "@/database/types";

class PluginStorageRepository {
	readonly table = schema.pluginStorage;

	async find(pluginId: string, key: string): Promise<string | undefined> {
		const [entry] = await databaseFactory
			.getClient()
			.select({ value: this.table.value })
			.from(this.table)
			.where(and(eq(this.table.pluginId, pluginId), eq(this.table.key, key)))
			.limit(1);

		return entry?.value;
	}

	async set(pluginId: string, key: string, value: string): Promise<void> {
		await databaseFactory
			.getClient()
			.insert(this.table)
			.values({ pluginId, key, value })
			.onConflictDoUpdate({
				target: [this.table.pluginId, this.table.key],
				set: { value, updatedAt: new Date() },
			});
	}

	async delete(pluginId: string, key: string): Promise<void> {
		await databaseFactory
			.getClient()
			.delete(this.table)
			.where(and(eq(this.table.pluginId, pluginId), eq(this.table.key, key)));
	}

	async deleteForPlugin(pluginId: string): Promise<void> {
		await databaseFactory.getClient().delete(this.table).where(eq(this.table.pluginId, pluginId));
	}

	async findKeysByPlugin(pluginId: string): Promise<string[]> {
		const rows = await databaseFactory
			.getClient()
			.select({ key: this.table.key })
			.from(this.table)
			.where(eq(this.table.pluginId, pluginId));

		return rows.map((row) => row.key);
	}
}

export const pluginStorageRepository = new PluginStorageRepository();

class PluginBlobsRepository {
	readonly table = schema.pluginBlobs;

	async find(pluginId: string, key: string, tx?: DatabaseTransaction) {
		const [entry] = await databaseFactory
			.getClient({ tx })
			.select()
			.from(this.table)
			.where(and(eq(this.table.pluginId, pluginId), eq(this.table.key, key)))
			.limit(1);

		return entry;
	}

	async findByPlugin(pluginId: string, options?: { tx?: DatabaseTransaction | undefined; afterKey?: string | undefined; limit?: number }) {
		const conditions = [eq(this.table.pluginId, pluginId)];
		if (options?.afterKey) conditions.push(gt(this.table.key, options.afterKey));

		const query = databaseFactory
			.getClient({ tx: options?.tx })
			.select()
			.from(this.table)
			.where(and(...conditions))
			.orderBy(asc(this.table.key));

		return options?.limit === undefined ? await query : await query.limit(options.limit);
	}

	async deleteByKeys(pluginId: string, keys: string[]): Promise<void> {
		if (keys.length === 0) return;

		await databaseFactory
			.getClient()
			.delete(this.table)
			.where(and(eq(this.table.pluginId, pluginId), inArray(this.table.key, keys)));
	}

	async sumSizeByPlugin(pluginId: string, tx?: DatabaseTransaction): Promise<number> {
		// Expired blobs are purged lazily (purgeExpired) — they must not count
		// against the quota while they still exist on disk only nominally.
		const now = new Date();
		const [result] = await databaseFactory
			.getClient({ tx })
			.select({ totalSize: sum(this.table.size) })
			.from(this.table)
			.where(and(eq(this.table.pluginId, pluginId), or(isNull(this.table.expiresAt), gt(this.table.expiresAt, now))));

		return Number(result?.totalSize ?? 0);
	}

	async findExpired(now: Date, limit?: number) {
		const query = databaseFactory
			.getClient()
			.select()
			.from(this.table)
			.where(lte(this.table.expiresAt, now))
			.orderBy(asc(this.table.expiresAt));

		return limit === undefined ? await query : await query.limit(limit);
	}

	async set(values: typeof this.table.$inferInsert, tx?: DatabaseTransaction): Promise<void> {
		await databaseFactory
			.getClient({ tx })
			.insert(this.table)
			.values(values)
			.onConflictDoUpdate({
				target: [this.table.pluginId, this.table.key],
				set: {
					storageKey: values.storageKey,
					contentType: values.contentType,
					size: values.size,
					expiresAt: values.expiresAt,
					createdAt: values.createdAt,
					updatedAt: new Date(),
				},
			});
	}

	async delete(pluginId: string, key: string, tx?: DatabaseTransaction): Promise<void> {
		await databaseFactory
			.getClient({ tx })
			.delete(this.table)
			.where(and(eq(this.table.pluginId, pluginId), eq(this.table.key, key)));
	}
}

export const pluginBlobsRepository = new PluginBlobsRepository();
