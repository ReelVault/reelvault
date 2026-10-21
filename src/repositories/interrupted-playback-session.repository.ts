import { lt } from "drizzle-orm";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";

export const interruptedPlaybackSessionRepository = {
	async insert(values: typeof schema.interruptedPlaybackSessions.$inferInsert): Promise<void> {
		await databaseFactory.getClient().insert(schema.interruptedPlaybackSessions).values(values);
	},

	async pruneOlderThan(cutoff: Date): Promise<number> {
		const result = await databaseFactory
			.getClient()
			.delete(schema.interruptedPlaybackSessions)
			.where(lt(schema.interruptedPlaybackSessions.endedAt, cutoff));

		return result.changes;
	},
};
