import type {
	CreateWatchedHistory,
	CursorPaginatedResponse,
	CursorPaginationQuery,
	WatchedHistoryWithRelations,
} from "@reelvault/sdk/common";
import type { DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import { findGlobalAnalytics, findTopPlayedMedia, findTopWatchedMedia } from "./watched-history/analytics.reader";
import { clearForProfile, hasFullWatch, isWatched, pruneOlderThan, recordPlay, recordPlays } from "./watched-history/history.repository";
import { findInsightAggregates, findInsightRelations } from "./watched-history/insights.reader";
import { findWatchedPage } from "./watched-history/listing.reader";

class WatchedHistoryRepository {
	isWatched(profileId: string, metadataId: string): Promise<boolean> {
		return isWatched(profileId, metadataId);
	}

	findPage(
		profileId: string,
		query: CursorPaginationQuery & { sortBy?: "watchedAt" | "createdAt"; sortOrder?: "asc" | "desc" },
	): Promise<CursorPaginatedResponse<WatchedHistoryWithRelations>> {
		return findWatchedPage(profileId, query);
	}

	/** Aggregated per (metadata, local day, hour) insight rows; see {@link findInsightAggregates}. */
	findInsightAggregates(profileId: string, since?: Date, until?: Date) {
		return findInsightAggregates(profileId, since, until);
	}

	findInsightRelations(metadataIds: string[]) {
		return findInsightRelations(metadataIds);
	}

	findTopWatchedMedia(...args: Parameters<typeof findTopWatchedMedia>) {
		return findTopWatchedMedia(...args);
	}

	findTopPlayedMedia(...args: Parameters<typeof findTopPlayedMedia>) {
		return findTopPlayedMedia(...args);
	}

	findGlobalAnalytics(...args: Parameters<typeof findGlobalAnalytics>) {
		return findGlobalAnalytics(...args);
	}

	/** Records a play that ends now. */
	recordPlay(input: CreateWatchedHistory & { profileId: string }, tx?: DatabaseTransaction) {
		return recordPlay(input, tx);
	}

	/** Records many plays that end now in one insert (bulk "mark watched"). */
	recordPlays(inputs: Array<CreateWatchedHistory & { profileId: string }>, tx?: DatabaseTransaction) {
		return recordPlays(inputs, tx);
	}

	/** True when this profile already has a full-watch row for the file — manual "mark watched" is idempotent. */
	hasFullWatch(profileId: string, mediaFileId: string) {
		return hasFullWatch(profileId, mediaFileId);
	}

	clearForProfile(profileId: string, tx?: DatabaseTransaction) {
		return clearForProfile(profileId, tx);
	}

	pruneOlderThan(cutoff: Date) {
		return pruneOlderThan(cutoff);
	}
}

export const watchedHistoryRepository = new WatchedHistoryRepository();
