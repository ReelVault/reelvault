import type { PlaybackItemStatus, PlaybackProgressItem } from "@reelvault/sdk/common";
import { maxBy } from "@/utils/array.utils";

export function getPlaybackItemStatus(progress: readonly PlaybackProgressItem[]): PlaybackItemStatus {
	// Status follows whichever record was updated most recently, not "any completed
	// record ever, no matter how old". Previously, a movie watched months ago but
	// recently restarted (position > 0, completed: false, newer updatedAt) still came
	// back as "watched" because an older completed row outranked it unconditionally —
	// so a rewatch-in-progress never showed up as in_progress.
	const latest = maxBy(progress, (item) => new Date(item.updatedAt).getTime());

	if (!latest) return { status: "unwatched", progress: null };

	if (latest.completed) return { status: "watched", progress: latest };

	if (latest.position > 0) return { status: "in_progress", progress: latest };

	return { status: "unwatched", progress: latest };
}
