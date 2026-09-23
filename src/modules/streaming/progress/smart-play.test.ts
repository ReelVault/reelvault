import { describe, expect, test } from "bun:test";
import { selectEpisodeSmartPlay, selectMovieSmartPlay } from "./smart-play";

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
