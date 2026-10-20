import { findGlobalAnalytics, findTopPlayedMedia, findTopWatchedMedia } from "./watched-history/analytics.reader";
import { clearForProfile, hasFullWatch, isWatched, pruneOlderThan, recordPlay, recordPlays } from "./watched-history/history.repository";
import { findInsightAggregates, findInsightRelations } from "./watched-history/insights.reader";
import { findWatchedPage } from "./watched-history/listing.reader";

export const watchedHistoryRepository = {
	isWatched,
	findPage: findWatchedPage,
	/** Aggregated per (metadata, local day, hour) insight rows; see {@link findInsightAggregates}. */
	findInsightAggregates,
	findInsightRelations,
	findTopWatchedMedia,
	findTopPlayedMedia,
	findGlobalAnalytics,
	/** Records a play that ends now. */
	recordPlay,
	/** Records many plays that end now in one insert (bulk "mark watched"). */
	recordPlays,
	/** True when this profile already has a full-watch row for the file — manual "mark watched" is idempotent. */
	hasFullWatch,
	clearForProfile,
	pruneOlderThan,
};
