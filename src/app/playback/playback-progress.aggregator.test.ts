import { describe, expect, test } from "bun:test";
import { computePlaybackProgress, computeSmartPlay } from "./playback-progress.aggregator";

describe("playback progress aggregator", () => {
	describe("computePlaybackProgress", () => {
		test("movie: derives status from the newest progress row and fills fileProgress", () => {
			const result = computePlaybackProgress({
				metadata: { type: "movie" },
				mediaFiles: [{ id: "file-1", movieId: "movie-1", episodeId: null }],
				progressRows: [
					{ mediaFileId: "file-1", position: 600, duration: 1200, completed: false, updatedAt: new Date("2026-01-02T00:00:00Z") },
				],
				episodes: [],
			});

			expect(result.status).toBe("in_progress");
			expect(result.progress).toMatchObject({ mediaFileId: "file-1" });
			expect(result.fileProgress["file-1"]?.status).toBe("in_progress");
			expect(result.completedEpisodes).toBe(0);
			expect(result.totalEpisodes).toBe(0);
			expect(result.episodes).toEqual({});
		});

		test("tv: aggregates per-episode statuses and counts completed regular episodes", () => {
			const result = computePlaybackProgress({
				metadata: { type: "tv_show" },
				mediaFiles: [
					{ id: "file-1", movieId: null, episodeId: "ep-1" },
					{ id: "file-2", movieId: null, episodeId: "ep-2" },
				],
				progressRows: [
					{ mediaFileId: "file-1", position: 1200, duration: 1200, completed: true, updatedAt: new Date("2026-01-01T00:00:00Z") },
					{ mediaFileId: "file-2", position: 300, duration: 1200, completed: false, updatedAt: new Date("2026-01-02T00:00:00Z") },
				],
				episodes: [{ id: "ep-1" }, { id: "ep-2" }],
			});

			expect(result.status).toBe("in_progress");
			expect(result.completedEpisodes).toBe(1);
			expect(result.totalEpisodes).toBe(2);
			expect(result.episodes["ep-1"]?.status).toBe("watched");
			expect(result.episodes["ep-2"]?.status).toBe("in_progress");
		});

		test("tv: reports watched only when every playable regular episode is watched", () => {
			const progressRows = [{ mediaFileId: "file-1", position: 1200, duration: 1200, completed: true, updatedAt: new Date() }];
			const allWatched = computePlaybackProgress({
				metadata: { type: "tv_show" },
				mediaFiles: [{ id: "file-1", movieId: null, episodeId: "ep-1" }],
				progressRows,
				episodes: [{ id: "ep-1" }],
			});
			expect(allWatched.status).toBe("watched");

			const withSpecial = computePlaybackProgress({
				metadata: { type: "tv_show" },
				mediaFiles: [{ id: "file-1", movieId: null, episodeId: "ep-1" }],
				progressRows,
				episodes: [{ id: "ep-1" }, { id: "ep-special", episodeType: "special" }],
			});
			expect(withSpecial.status).toBe("watched");
			expect(withSpecial.totalEpisodes).toBe(1);
		});

		test("tv: unwatched when there is no progress at all", () => {
			const result = computePlaybackProgress({
				metadata: { type: "tv_show" },
				mediaFiles: [{ id: "file-1", movieId: null, episodeId: "ep-1" }],
				progressRows: [],
				episodes: [{ id: "ep-1" }],
			});

			expect(result.status).toBe("unwatched");
			expect(result.totalEpisodes).toBe(1);
		});
	});

	describe("computeSmartPlay", () => {
		test("movie: continues in-progress playback", () => {
			const result = computeSmartPlay({
				metadata: { type: "movie" },
				mediaFiles: [{ id: "file-1", movieId: "movie-1", episodeId: null, isDefault: false, updatedAt: new Date(1000) }],
				progressRows: [{ mediaFileId: "file-1", position: 300, completed: false, updatedAt: new Date(2000) }],
				episodes: [],
			});

			expect(result.suggestion).toMatchObject({ type: "continue", mediaFileId: "file-1" });
		});

		test("movie: suggests the default file when there is no progress", () => {
			const result = computeSmartPlay({
				metadata: { type: "movie" },
				mediaFiles: [
					{ id: "file-1", movieId: "movie-1", episodeId: null, isDefault: false, updatedAt: new Date(5000) },
					{ id: "file-2", movieId: "movie-1", episodeId: null, isDefault: true, updatedAt: new Date(1000) },
				],
				progressRows: [],
				episodes: [],
			});

			expect(result.suggestion).toMatchObject({ type: "new", mediaFileId: "file-2" });
		});

		test("tv: returns null suggestion without seasons", () => {
			const result = computeSmartPlay({
				metadata: { type: "tv_show" },
				mediaFiles: [{ id: "file-1", movieId: null, episodeId: "ep-1", isDefault: true, updatedAt: new Date() }],
				progressRows: [],
				episodes: [{ id: "ep-1", seasonId: "season-1", episodeNumber: 1 }],
			});

			expect(result.suggestion).toBeNull();
		});

		test("tv: recommends the next episode after a completed one", () => {
			const result = computeSmartPlay({
				metadata: { type: "tv_show" },
				mediaFiles: [
					{ id: "file-1", movieId: null, episodeId: "ep-1", isDefault: true, updatedAt: new Date(1000) },
					{ id: "file-2", movieId: null, episodeId: "ep-2", isDefault: true, updatedAt: new Date(1000) },
				],
				progressRows: [{ mediaFileId: "file-1", episodeId: "ep-1", position: 1200, completed: true, updatedAt: new Date(2000) }],
				seasons: [{ id: "season-1", seasonNumber: 1 }],
				episodes: [
					{ id: "ep-1", seasonId: "season-1", episodeNumber: 1, episodeType: "regular" },
					{ id: "ep-2", seasonId: "season-1", episodeNumber: 2, episodeType: "regular" },
				],
			});

			expect(result.suggestion).toMatchObject({ type: "next_episode", mediaFileId: "file-2" });
		});
	});
});
