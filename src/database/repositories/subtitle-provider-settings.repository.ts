import { eq } from "drizzle-orm";
import { databaseFactory } from "@/database/database";
import { schema } from "@/database/schema";

const settings = schema.subtitleProviderSettings;

class SubtitleProviderSettingsRepository {
	/** Ids of the providers switched off; a provider without a row is on. */
	async listDisabledIds(): Promise<string[]> {
		const rows = await databaseFactory
			.getClient()
			.select({ providerId: settings.providerId })
			.from(settings)
			.where(eq(settings.enabled, false));

		return rows.map((row) => row.providerId);
	}

	async isDisabled(providerId: string): Promise<boolean> {
		const [row] = await databaseFactory
			.getClient()
			.select({ enabled: settings.enabled })
			.from(settings)
			.where(eq(settings.providerId, providerId))
			.limit(1);

		return row?.enabled === false;
	}

	async setEnabled(providerId: string, enabled: boolean): Promise<void> {
		await databaseFactory
			.getClient()
			.insert(settings)
			.values({ providerId, enabled })
			.onConflictDoUpdate({ target: settings.providerId, set: { enabled, updatedAt: new Date() } });
	}
}

export const subtitleProviderSettingsRepository = new SubtitleProviderSettingsRepository();
