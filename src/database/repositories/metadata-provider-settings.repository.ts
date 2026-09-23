import { asc, sql } from "drizzle-orm";
import { databaseFactory } from "@/database/database";
import { schema } from "@/database/schema";

const settings = schema.metadataProviderSettings;

export type MetadataProviderSetting = typeof settings.$inferSelect;

class MetadataProviderSettingsRepository {
	async list(): Promise<MetadataProviderSetting[]> {
		return await databaseFactory.getClient().select().from(settings).orderBy(asc(settings.priority), asc(settings.providerId));
	}

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
		await databaseFactory
			.getClient()
			.insert(settings)
			.values(items)
			.onConflictDoUpdate({
				target: settings.providerId,
				set: { priority: sql`excluded.priority`, updatedAt: now },
			});
	}

	async upsert(providerId: string, values: { priority?: number; enabled?: boolean }): Promise<MetadataProviderSetting> {
		const [setting] = await databaseFactory
			.getClient()
			.insert(settings)
			.values({ providerId, priority: values.priority ?? 100, enabled: values.enabled ?? true })
			.onConflictDoUpdate({
				target: settings.providerId,
				set: {
					...(values.priority === undefined ? {} : { priority: values.priority }),
					...(values.enabled === undefined ? {} : { enabled: values.enabled }),
					updatedAt: new Date(),
				},
			})
			.returning();
		if (!setting) throw new Error(`Failed to save metadata provider settings: ${providerId}`);

		return setting;
	}
}

export const metadataProviderSettingsRepository = new MetadataProviderSettingsRepository();
