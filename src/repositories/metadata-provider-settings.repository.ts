import { asc, sql } from "drizzle-orm";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { defineTableAccess } from "@/integrations/drizzle-orm/query/table-access/table-access.factory";
import { DomainError } from "@/utils/domain.errors";

const settings = schema.metadataProviderSettings;
const settingsAccess = defineTableAccess("metadataProviderSettings", { primaryKeyColumn: "providerId" });

export type MetadataProviderSetting = typeof settings.$inferSelect;

export const metadataProviderSettingsRepository = {
	async list(): Promise<MetadataProviderSetting[]> {
		return await databaseFactory.getClient().select().from(settings).orderBy(asc(settings.priority), asc(settings.providerId));
	},

	/** Assigns sequential priorities (10, 20, 30…) in the given order. Providers omitted keep their current priority. */
	async reorder(providerIds: readonly string[]): Promise<void> {
		const items = providerIds
			.filter((id): id is string => Boolean(id))
			.map((providerId, index) => ({
				providerId,
				priority: (index + 1) * 10,
				enabled: true,
			}));
		if (items.length === 0) return;

		const now = new Date();
		await settingsAccess.upsert({
			values: items,
			target: settingsAccess.table.providerId,
			set: { priority: sql`excluded.priority`, updatedAt: now },
		});
	},

	async upsert(providerId: string, values: { priority?: number; enabled?: boolean }): Promise<MetadataProviderSetting> {
		const [setting] = await settingsAccess.upsert({
			values: { providerId, priority: values.priority ?? 100, enabled: values.enabled ?? true },
			target: settingsAccess.table.providerId,
			set: {
				...(values.priority === undefined ? {} : { priority: values.priority }),
				...(values.enabled === undefined ? {} : { enabled: values.enabled }),
				updatedAt: new Date(),
			},
			returning: true,
		});
		if (!setting)
			throw new DomainError("internal", `Failed to save metadata provider settings: ${providerId}`, {
				code: "metadata_provider_settings.save_failed",
			});

		return setting;
	},
};
