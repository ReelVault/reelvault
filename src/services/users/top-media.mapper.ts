import type { TopWatchedMedia } from "@reelvault/sdk/common";
import { serverConstants } from "@/config/server/server.constants";
import type { TopWatchedRow } from "@/repositories/watched-history/top-media.mapper";
import { extractYear } from "@/utils/media-match/normalize.utils";

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
