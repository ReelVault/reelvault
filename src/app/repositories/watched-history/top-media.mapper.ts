import type { TopWatchedMedia } from "@reelvault/sdk/common";
import { serverConstants } from "@/config/server/server.constants";

/** One title of a most-watched list, as the top-media queries return it. */
export interface TopWatchedRow {
	id: string;
	title: string;
	type: "movie" | "tv_show";
	releaseDate: string | null;
	posterImageId: string | null;
	posterImageUpdatedAt: Date | null;
	totalDurationWatched: number;
	watchCount: number;
	isCompleted: boolean;
}

export function toTopWatchedMedia(row: TopWatchedRow): TopWatchedMedia {
	return {
		id: row.id,
		title: row.title,
		type: row.type,
		posterUrl: row.posterImageId ? `${serverConstants.security.imageRoutePrefix}${row.posterImageId}` : null,
		posterUpdatedAt: row.posterImageUpdatedAt ?? null,
		backdropUrl: null,
		releaseYear: row.releaseDate ? new Date(row.releaseDate).getFullYear() : null,
		minutes: Math.round(row.totalDurationWatched / 60),
		watchCount: row.watchCount,
		completed: row.isCompleted,
	};
}
