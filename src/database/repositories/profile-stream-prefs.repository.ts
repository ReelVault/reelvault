import { and, eq } from "drizzle-orm";
import { type DatabaseFactory, databaseFactory } from "@/database/database";
import { schema } from "@/database/schema";
import type { DatabaseTransaction } from "@/database/types";

export interface ProfileStreamPrefs {
	audioLanguage: string | null;
	subtitleLanguage: string | null;
}

export interface UpsertProfileStreamPrefsInput {
	profileId: string;
	metadataId: string;
	/** undefined = leave the stored language untouched; null = clear it. */
	audioLanguage?: string | null | undefined;
	subtitleLanguage?: string | null | undefined;
}

class ProfileStreamPrefsRepository {
	readonly table = schema.profileStreamPrefs;
	private readonly database: Pick<DatabaseFactory, "getClient">;

	constructor(database: Pick<DatabaseFactory, "getClient"> = databaseFactory) {
		this.database = database;
	}

	async upsert(input: UpsertProfileStreamPrefsInput, tx?: DatabaseTransaction): Promise<void> {
		await this.database
			.getClient({ tx })
			.insert(this.table)
			.values({
				profileId: input.profileId,
				metadataId: input.metadataId,
				audioLanguage: input.audioLanguage ?? null,
				subtitleLanguage: input.subtitleLanguage ?? null,
			})
			.onConflictDoUpdate({
				target: [this.table.profileId, this.table.metadataId],
				set: {
					...(input.audioLanguage !== undefined ? { audioLanguage: input.audioLanguage } : {}),
					...(input.subtitleLanguage !== undefined ? { subtitleLanguage: input.subtitleLanguage } : {}),
					updatedAt: new Date(),
				},
			});
	}

	async find(profileId: string, metadataId: string): Promise<ProfileStreamPrefs | null> {
		const row = await this.database
			.getClient()
			.select({ audioLanguage: this.table.audioLanguage, subtitleLanguage: this.table.subtitleLanguage })
			.from(this.table)
			.where(and(eq(this.table.profileId, profileId), eq(this.table.metadataId, metadataId)))
			.limit(1)
			.then((rows) => rows[0]);

		return row ?? null;
	}
}

export const profileStreamPrefsRepository = new ProfileStreamPrefsRepository();
