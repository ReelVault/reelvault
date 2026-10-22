import type { TopWatchedMedia } from "@reelvault/sdk/common";
import { serverConstants } from "@/config/server/server.constants";
import { extractYear } from "@/utils/media-match/normalize.utils";

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
		// The year is read from the date text: parsing it would shift a 1 January release into the previous year west of UTC.
		releaseYear: extractYear(row.releaseDate ?? undefined) ?? null,
		minutes: Math.round(row.totalDurationWatched / 60),
		watchCount: row.watchCount,
		completed: row.isCompleted,
	};
}
