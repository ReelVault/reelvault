import { eq } from "drizzle-orm";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { defineTableAccess } from "@/integrations/drizzle-orm/query/table-access/table-access.factory";

const settings = schema.subtitleProviderSettings;
const settingsAccess = defineTableAccess("subtitleProviderSettings", { primaryKeyColumn: "providerId" });

export const subtitleProviderSettingsRepository = {
	/** Ids of the providers switched off; a provider without a row is on. */
	async listDisabledIds(): Promise<string[]> {
		const rows = await databaseFactory
			.getClient()
			.select({ providerId: settings.providerId })
			.from(settings)
			.where(eq(settings.enabled, false));

		return rows.map((row) => row.providerId);
	},

	async isDisabled(providerId: string): Promise<boolean> {
		const [row] = await databaseFactory
			.getClient()
			.select({ enabled: settings.enabled })
			.from(settings)
			.where(eq(settings.providerId, providerId))
			.limit(1);

		return row?.enabled === false;
	},

	async setEnabled(providerId: string, enabled: boolean): Promise<void> {
		await settingsAccess.upsert({
			values: { providerId, enabled },
			target: settingsAccess.table.providerId,
			set: { enabled, updatedAt: new Date() },
		});
	},
};
