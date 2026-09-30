import type { LibraryProviderPriority } from "@reelvault/sdk/common";
import { eq } from "drizzle-orm";
import { databaseFactory } from "@/database/database";
import { libraryProviderSettings } from "@/database/schemas/library-provider-settings.schema";

export interface LibraryProviderSettingRow {
	libraryId: string;
	providerId: string;
	priority: number;
	enabled: boolean;
}

class LibraryProviderSettingsRepository {
	async listForLibrary(libraryId: string): Promise<LibraryProviderSettingRow[]> {
		return await databaseFactory
			.getClient()
			.select({
				libraryId: libraryProviderSettings.libraryId,
				providerId: libraryProviderSettings.providerId,
				priority: libraryProviderSettings.priority,
				enabled: libraryProviderSettings.enabled,
			})
			.from(libraryProviderSettings)
			.where(eq(libraryProviderSettings.libraryId, libraryId));
	}

	/** Replaces the whole override set for one library in a single delete+insert pass. */
	async replaceForLibrary(libraryId: string, priorities: LibraryProviderPriority[]): Promise<void> {
		const client = databaseFactory.getClient();
		await client.delete(libraryProviderSettings).where(eq(libraryProviderSettings.libraryId, libraryId));

		if (priorities.length === 0) return;

		await client.insert(libraryProviderSettings).values(
			priorities.map((item) => ({
				libraryId,
				providerId: item.providerId,
				priority: item.priority,
				enabled: item.enabled,
			})),
		);
	}
}

export const libraryProviderSettingsRepository = new LibraryProviderSettingsRepository();
