import { inArray, sql } from "drizzle-orm";
import { databaseFactory } from "@/database/database";
import { schema } from "@/database/schema";
import type { DatabaseTransaction } from "@/database/types";

const table = schema.systemSettings;

export type SystemSettingRow = typeof table.$inferSelect;

class SystemSettingsRepository {
	async list(tx?: DatabaseTransaction): Promise<SystemSettingRow[]> {
		return await databaseFactory.getClient({ tx }).select().from(table);
	}

	async setMany(entries: Array<{ key: string; value: string }>, tx?: DatabaseTransaction): Promise<void> {
		if (entries.length === 0) return;

		const now = new Date();
		const client = databaseFactory.getClient({ tx });
		await client
			.insert(table)
			.values(entries.map((entry) => ({ key: entry.key, value: entry.value, createdAt: now, updatedAt: now })))
			.onConflictDoUpdate({
				target: table.key,
				set: { value: sql`excluded.value`, updatedAt: now },
			});
	}

	async deleteMany(keys: string[], tx?: DatabaseTransaction): Promise<void> {
		if (keys.length === 0) return;

		await databaseFactory.getClient({ tx }).delete(table).where(inArray(table.key, keys));
	}
}

export const systemSettingsRepository = new SystemSettingsRepository();
