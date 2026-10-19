import type { LibraryProviderPriority } from "@reelvault/sdk/common";
import { eq } from "drizzle-orm";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { libraryProviderSettings } from "@/integrations/drizzle-orm/schemas/library-provider-settings.schema";

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

	/** Replaces the whole override set for one library in a single transaction. */
	async replaceForLibrary(libraryId: string, priorities: LibraryProviderPriority[]): Promise<void> {
		// Input order wins on duplicates: the table's PK is (library_id, provider_id).
		const unique = [...new Map(priorities.map((item) => [item.providerId, item])).values()];

		await databaseFactory.transaction(async (tx) => {
			await tx.delete(libraryProviderSettings).where(eq(libraryProviderSettings.libraryId, libraryId));

			if (unique.length === 0) return;

			await tx.insert(libraryProviderSettings).values(
				unique.map((item) => ({
					libraryId,
					providerId: item.providerId,
					priority: item.priority,
					enabled: item.enabled,
				})),
			);
		});
	}
}

export const libraryProviderSettingsRepository = new LibraryProviderSettingsRepository();
