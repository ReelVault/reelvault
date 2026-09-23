import type {
	ContinueWatchingResponse,
	InsightsRange,
	MetadataPlaybackProgress,
	ProfileInsights,
	SessionResponse,
	SmartPlayResponse,
	WrappedInsights,
} from "@sdk/common";
import type { FieldsQuery, SelectFields } from "@sdk/common/fields";
import type { PaginatedResponse, PaginationQuery } from "@sdk/common/pagination";
import type { StreamPrefs, UpdatePlaybackProgress } from "@sdk/common/playback-progress.types";
import type { CreateUserRatingRequest, UserRating, UserRatingFilters, UserRatingSorting } from "@sdk/common/user-ratings.types";
import type { CreateWatchedHistory, WatchedHistoryWithRelations } from "@sdk/common/watched-history.types";
import type { Watchlist, WatchlistFilters, WatchlistSorting } from "@sdk/common/watchlist.types";
import { BaseResource } from "../core/base-client";

export class MeClient extends BaseResource {
	// Account & Session
	get(): Promise<SessionResponse> {
		return this._get("/me");
	}

	// Playback & Progress
	getContinueWatching(limit = 12): Promise<ContinueWatchingResponse> {
		return this._get("/me/continue-watching", { query: { limit } });
	}

	getPlaybackProgress(metadataId: string): Promise<MetadataPlaybackProgress> {
		return this._get(`/me/playback-progress/${metadataId}`);
	}

	updatePlaybackProgress(mediaFileId: string, body: UpdatePlaybackProgress): Promise<{ success: true }> {
		return this._put(`/me/media-files/${mediaFileId}/playback-progress`, { body });
	}

	resetPlaybackProgress(mediaFileId: string): Promise<{ success: true }> {
		return this._delete(`/me/media-files/${mediaFileId}/playback-progress`);
	}

	getStreamPrefs(mediaFileId: string): Promise<StreamPrefs> {
		return this._get(`/me/stream-prefs/${mediaFileId}`);
	}

	getPlaybackSuggestions(metadataId: string): Promise<SmartPlayResponse> {
		return this._get(`/me/playback-suggestions/${metadataId}`);
	}

	// Watchlist
	getWatchlist<F extends string = string>(
		query?: PaginationQuery & FieldsQuery<F> & WatchlistFilters & WatchlistSorting,
	): Promise<PaginatedResponse<SelectFields<Watchlist, F>>> {
		return this._get("/me/watchlist", { query });
	}

	addToWatchlist(metadataId: string): Promise<{ success: true; added: true }> {
		return this._post("/me/watchlist", { body: { metadataId } });
	}

	removeFromWatchlist(metadataId: string): Promise<{ success: true; removed: true }> {
		return this._delete(`/me/watchlist/${metadataId}`);
	}

	isInWatchlist(metadataId: string): Promise<{ inWatchlist: boolean }> {
		return this._get(`/me/watchlist/${metadataId}`);
	}

	getWatchlistStatuses(metadataIds: string[]): Promise<{ statuses: Array<{ metadataId: string; inWatchlist: boolean }> }> {
		return this._get("/me/watchlist/statuses", { query: { ids: metadataIds.join(",") } });
	}

	toggleWatchlist(metadataId: string): Promise<{ added: boolean }> {
		return this._post("/me/watchlist/toggle", { body: { metadataId } });
	}

	// Watched History
	getWatchedHistory(query?: { limit?: number; page?: number; perPage?: number }): Promise<PaginatedResponse<WatchedHistoryWithRelations>> {
		return this._get("/me/watched-history", { query });
	}

	syncWatchedHistory(body: CreateWatchedHistory): Promise<{ success: true }> {
		return this._post("/me/watched-history", { body });
	}

	getInsights(range: InsightsRange): Promise<ProfileInsights> {
		return this._get("/me/watched-history/insights", { query: { range } });
	}

	getWrapped(year?: number): Promise<WrappedInsights> {
		return this._get("/me/watched-history/wrapped", { query: year ? { year } : undefined });
	}

	isWatched(metadataId: string): Promise<{ watched: boolean }> {
		return this._get(`/me/watched-history/${metadataId}/watched`);
	}

	clearWatchedHistory(): Promise<{ success: true }> {
		return this._delete("/me/watched-history");
	}

	// User Ratings
	getRatings<F extends string = string>(
		query?: PaginationQuery & FieldsQuery<F> & UserRatingFilters & UserRatingSorting,
	): Promise<PaginatedResponse<SelectFields<UserRating, F>>> {
		return this._get("/me/ratings", { query });
	}

	rate(body: CreateUserRatingRequest): Promise<UserRating> {
		return this._post("/me/ratings", { body });
	}

	deleteRating(metadataId: string): Promise<{ success: boolean }> {
		return this._delete(`/me/ratings/${metadataId}`);
	}
}
