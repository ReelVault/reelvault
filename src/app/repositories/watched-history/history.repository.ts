import type { CreateWatchedHistory } from "@reelvault/sdk/common";
import { and, eq, lt } from "drizzle-orm";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import type { DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import { watchedHistory } from "./shared.schema";

/** Whether the profile has any play of a title, whichever episode or file it was. */
export async function isWatched(profileId: string, metadataId: string): Promise<boolean> {
	const [history] = await databaseFactory
		.getClient()
		.select({ id: schema.watchedHistory.id })
		.from(schema.watchedHistory)
		.innerJoin(schema.mediaFiles, eq(schema.mediaFiles.id, schema.watchedHistory.mediaFileId))
		.where(and(eq(schema.watchedHistory.profileId, profileId), eq(schema.mediaFiles.metadataId, metadataId)))
		.limit(1);

	return Boolean(history);
}

/** Records a play that ends now. */
export async function recordPlay(
	{ profileId, mediaFileId, durationWatched, isFullWatch }: CreateWatchedHistory & { profileId: string },
	tx?: DatabaseTransaction,
): Promise<void> {
	await watchedHistory.insert({
		values: {
			profileId,
			mediaFileId,
			durationWatched,
			isFullWatch,
			watchedAt: new Date(),
		},
		tx,
	});
}

/** True when this profile already has a full-watch row for the file — manual "mark watched" is idempotent. */
export async function hasFullWatch(profileId: string, mediaFileId: string): Promise<boolean> {
	return await watchedHistory.isExists({
		where: and(
			eq(schema.watchedHistory.profileId, profileId),
			eq(schema.watchedHistory.mediaFileId, mediaFileId),
			eq(schema.watchedHistory.isFullWatch, true),
		),
	});
}

export async function clearForProfile(profileId: string, tx?: DatabaseTransaction): Promise<void> {
	await watchedHistory.delete({ where: eq(schema.watchedHistory.profileId, profileId), tx });
}

/** Deletes plays that ended before `cutoff`. Returns how many were deleted. */
export async function pruneOlderThan(cutoff: Date): Promise<number> {
	const result = await databaseFactory.getClient().delete(schema.watchedHistory).where(lt(schema.watchedHistory.watchedAt, cutoff));

	return result.changes;
}
