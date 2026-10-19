import { describe, expect, test } from "bun:test";
import { selectEpisodeSmartPlay, selectMovieSmartPlay, selectNextEpisodeFileInSeries } from "./smart-play.resolver";

const updatedAt = new Date("2026-01-01T00:00:00.000Z");

describe("smart play selection", () => {
	test("returns no suggestion when a movie has no playable files", () => {
		expect(selectMovieSmartPlay([])).toBeUndefined();
	});

	test("starts a new movie from the newest playable file", () => {
		const files = [
			{ id: "old", episodeId: null, updatedAt, isDefault: false },
			{ id: "new", episodeId: null, updatedAt: new Date("2026-02-01T00:00:00.000Z"), isDefault: false },
		];
		expect(selectMovieSmartPlay(files)).toEqual({ type: "new", mediaFileId: "new" });
	});

	test("prefers the default movie file over a newer file", () => {
		const files = [
			{ id: "default", episodeId: null, updatedAt, isDefault: true },
			{ id: "new", episodeId: null, updatedAt: new Date("2026-02-01T00:00:00.000Z"), isDefault: false },
		];
		expect(selectMovieSmartPlay(files)).toEqual({ type: "new", mediaFileId: "default" });
	});

	test("resumes a movie before choosing the latest file", () => {
		const files = [
			{ id: "old", episodeId: null, updatedAt, isDefault: false },
			{ id: "new", episodeId: null, updatedAt: new Date("2026-02-01T00:00:00.000Z"), isDefault: false },
		];
		expect(selectMovieSmartPlay(files, { mediaFileId: "old", episodeId: null, position: 90, completed: false })).toEqual({
			type: "continue",
			mediaFileId: "old",
		});
	});

	test("selects the next playable regular episode across seasons", () => {
		const episodes = [
			{ id: "s1e1", seasonNumber: 1, episodeNumber: 1 },
			{ id: "s2e1", seasonNumber: 2, episodeNumber: 1 },
		];
		const files = [
			{ id: "file-1", episodeId: "s1e1", updatedAt, isDefault: false },
			{ id: "file-2", episodeId: "s2e1", updatedAt, isDefault: false },
		];
		expect(
			selectEpisodeSmartPlay(episodes, files, new Set(["s1e1"]), [
				{ mediaFileId: "file-1", episodeId: "s1e1", position: 100, completed: true, updatedAt },
			]),
		).toEqual({ type: "next_episode", mediaFileId: "file-2" });
	});

	test("prefers the default file for the next episode", () => {
		const episodes = [{ id: "s1e1", seasonNumber: 1, episodeNumber: 1 }];
		const files = [
			{ id: "default", episodeId: "s1e1", updatedAt, isDefault: true },
			{ id: "new", episodeId: "s1e1", updatedAt: new Date("2026-02-01T00:00:00.000Z"), isDefault: false },
		];
		expect(selectEpisodeSmartPlay(episodes, files, new Set(), [])).toEqual({ type: "new", mediaFileId: "default" });
	});

	test("supports rewatching: recommends episode 2 after rewatching episode 1 even if all were previously watched", () => {
		const episodes = [
			{ id: "s1e1", seasonNumber: 1, episodeNumber: 1 },
			{ id: "s1e2", seasonNumber: 1, episodeNumber: 2 },
			{ id: "s1e3", seasonNumber: 1, episodeNumber: 3 },
		];
		const files = [
			{ id: "file-1", episodeId: "s1e1", updatedAt, isDefault: false },
			{ id: "file-2", episodeId: "s1e2", updatedAt, isDefault: false },
			{ id: "file-3", episodeId: "s1e3", updatedAt, isDefault: false },
		];
		// All 3 were watched in 2024, but episode 1 was watched again today (2026)
		const oldDate = new Date("2024-01-01T00:00:00.000Z");
		const newDate = new Date("2026-08-25T12:00:00.000Z");
		const progress = [
			{ mediaFileId: "file-1", episodeId: "s1e1", position: 1200, completed: true, updatedAt: newDate },
			{ mediaFileId: "file-2", episodeId: "s1e2", position: 1200, completed: true, updatedAt: oldDate },
			{ mediaFileId: "file-3", episodeId: "s1e3", position: 1200, completed: true, updatedAt: oldDate },
		];
		const watchedEpisodeIds = new Set(["s1e1", "s1e2", "s1e3"]);

		expect(selectEpisodeSmartPlay(episodes, files, watchedEpisodeIds, progress)).toEqual({
			type: "next_episode",
			mediaFileId: "file-2",
		});
	});

	test("resumes in-progress episode over completed earlier episode during rewatch", () => {
		const episodes = [
			{ id: "s1e1", seasonNumber: 1, episodeNumber: 1 },
			{ id: "s1e2", seasonNumber: 1, episodeNumber: 2 },
		];
		const files = [
			{ id: "file-1", episodeId: "s1e1", updatedAt, isDefault: false },
			{ id: "file-2", episodeId: "s1e2", updatedAt, isDefault: false },
		];
		const newDate = new Date("2026-08-25T13:00:00.000Z");
		const progress = [{ mediaFileId: "file-1", episodeId: "s1e1", position: 500, completed: false, updatedAt: newDate }];

		expect(selectEpisodeSmartPlay(episodes, files, new Set(["s1e1", "s1e2"]), progress)).toEqual({
			type: "continue",
			mediaFileId: "file-1",
		});
	});
});

interface SeriesEpisodeSpec {
	id: string;
	season: number;
	number: number;
	files?: Array<{ id: string; isDefault?: boolean; updatedAt?: Date }>;
}

/** Smart-play shaped show data: the arrays the view and smart-play readers parse. */
function seriesData(specs: readonly SeriesEpisodeSpec[]) {
	const seasons = [...new Map(specs.map((spec) => [spec.season, { id: `s-${spec.season}`, seasonNumber: spec.season }])).values()];

	return {
		episodes: specs.map((spec) => ({ id: spec.id, seasonId: `s-${spec.season}`, episodeNumber: spec.number })),
		seasons,
		mediaFiles: specs.flatMap((spec) =>
			(spec.files ?? []).map((file) => ({
				id: file.id,
				episodeId: spec.id,
				isDefault: file.isDefault ?? false,
				updatedAt: file.updatedAt ?? updatedAt,
			})),
		),
	};
}

describe("next episode file selection", () => {
	test("returns the preferred file of the immediate next episode in the same season", () => {
		const { episodes, seasons, mediaFiles } = seriesData([
			{ id: "ep-1", season: 1, number: 1, files: [{ id: "f-1" }] },
			{ id: "ep-2", season: 1, number: 2, files: [{ id: "f-2" }] },
		]);

		expect(selectNextEpisodeFileInSeries(episodes, seasons, mediaFiles, { id: "ep-1", seasonId: "s-1" })).toBe("f-2");
	});

	test("orders episodes by season and episode number regardless of array order", () => {
		const { episodes, seasons, mediaFiles } = seriesData([
			{ id: "ep-2", season: 1, number: 2, files: [{ id: "f-2" }] },
			{ id: "ep-3", season: 2, number: 1, files: [{ id: "f-3" }] },
			{ id: "ep-1", season: 1, number: 1, files: [{ id: "f-1" }] },
		]);

		expect(selectNextEpisodeFileInSeries(episodes, seasons, mediaFiles, { id: "ep-1", seasonId: "s-1" })).toBe("f-2");
	});

	test("falls through to the first playable episode of the next season when the next episode has no file", () => {
		const { episodes, seasons, mediaFiles } = seriesData([
			{ id: "ep-1", season: 1, number: 1, files: [{ id: "f-1" }] },
			{ id: "ep-2", season: 1, number: 2 },
			{ id: "ep-3", season: 2, number: 1, files: [{ id: "f-3" }] },
		]);

		expect(selectNextEpisodeFileInSeries(episodes, seasons, mediaFiles, { id: "ep-1", seasonId: "s-1" })).toBe("f-3");
	});

	test("skips later seasons whose first episode has no file", () => {
		const { episodes, seasons, mediaFiles } = seriesData([
			{ id: "ep-1", season: 1, number: 1, files: [{ id: "f-1" }] },
			{ id: "ep-2", season: 2, number: 1 },
			{ id: "ep-3", season: 3, number: 1, files: [{ id: "f-3" }] },
		]);

		expect(selectNextEpisodeFileInSeries(episodes, seasons, mediaFiles, { id: "ep-1", seasonId: "s-1" })).toBe("f-3");
	});

	test("prefers the default file over a newer non-default file", () => {
		const older = new Date("2026-01-01T00:00:00Z");
		const newer = new Date("2026-02-01T00:00:00Z");
		const { episodes, seasons, mediaFiles } = seriesData([
			{ id: "ep-1", season: 1, number: 1, files: [{ id: "f-1" }] },
			{
				id: "ep-2",
				season: 1,
				number: 2,
				files: [
					{ id: "f-default", isDefault: true, updatedAt: older },
					{ id: "f-newer", updatedAt: newer },
				],
			},
		]);

		expect(selectNextEpisodeFileInSeries(episodes, seasons, mediaFiles, { id: "ep-1", seasonId: "s-1" })).toBe("f-default");
	});

	test("returns null at the end of the show", () => {
		const { episodes, seasons, mediaFiles } = seriesData([
			{ id: "ep-1", season: 1, number: 1, files: [{ id: "f-1" }] },
			{ id: "ep-2", season: 1, number: 2, files: [{ id: "f-2" }] },
		]);

		expect(selectNextEpisodeFileInSeries(episodes, seasons, mediaFiles, { id: "ep-2", seasonId: "s-1" })).toBeNull();
	});

	test("returns null when the current episode is not part of the show data", () => {
		const { episodes, seasons, mediaFiles } = seriesData([{ id: "ep-1", season: 1, number: 1, files: [{ id: "f-1" }] }]);

		expect(selectNextEpisodeFileInSeries(episodes, seasons, mediaFiles, { id: "ep-missing", seasonId: "s-1" })).toBeNull();
	});

	test("ignores earlier seasons and non-adjacent episodes in the same season", () => {
		const { episodes, seasons, mediaFiles } = seriesData([
			{ id: "ep-0", season: 0, number: 1, files: [{ id: "f-0" }] },
			{ id: "ep-1", season: 1, number: 1, files: [{ id: "f-1" }] },
			{ id: "ep-2", season: 1, number: 2 },
			{ id: "ep-3", season: 1, number: 3, files: [{ id: "f-3" }] },
		]);

		// The immediate next episode (ep-2) has no file, so the later-season scan
		// runs — there are no later seasons, and ep-3 must not be picked.
		expect(selectNextEpisodeFileInSeries(episodes, seasons, mediaFiles, { id: "ep-1", seasonId: "s-1" })).toBeNull();
	});
});
