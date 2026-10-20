import { inArray, sql } from "drizzle-orm";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import type { DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import { defineTableAccess } from "@/integrations/drizzle-orm/query/table-access/table-access.factory";

const table = schema.systemSettings;
const settingsAccess = defineTableAccess("systemSettings", { primaryKeyColumn: "key" });

export type SystemSettingRow = typeof table.$inferSelect;

export const systemSettingsRepository = {
	async list(tx?: DatabaseTransaction): Promise<SystemSettingRow[]> {
		return await databaseFactory.getClient({ tx }).select().from(table);
	},

	/** Saves values; `lastModifiedBy` names the administrator who saved each one (null when none is known). */
	async setMany(entries: Array<{ key: string; value: string; lastModifiedBy?: string | null }>, tx?: DatabaseTransaction): Promise<void> {
		if (entries.length === 0) return;

		const now = new Date();
		await settingsAccess.upsert({
			values: entries.map((entry) => ({
				key: entry.key,
				value: entry.value,
				lastModifiedBy: entry.lastModifiedBy ?? null,
				createdAt: now,
				updatedAt: now,
			})),
			target: settingsAccess.table.key,
			set: { value: sql`excluded.value`, lastModifiedBy: sql`excluded.last_modified_by`, updatedAt: now },
			tx,
		});
	},

	async deleteMany(keys: string[], tx?: DatabaseTransaction): Promise<void> {
		if (keys.length === 0) return;

		await databaseFactory.getClient({ tx }).delete(table).where(inArray(table.key, keys));
	},
};
