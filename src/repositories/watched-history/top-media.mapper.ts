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
