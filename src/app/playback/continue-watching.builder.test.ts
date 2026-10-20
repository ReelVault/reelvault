import { describe, expect, test } from "bun:test";
import type { ContinueWatchingData } from "@/modules/streaming/streaming.types";
import { buildContinueWatching } from "./continue-watching.builder";

function createData(overrides: Partial<ContinueWatchingData> = {}): ContinueWatchingData {
	return {
		progressRows: [],
		metadataList: [],
		mediaFiles: [],
		seasons: [],
		episodes: [],
		backdrops: [],
		...overrides,
	};
}

describe("continue watching builder", () => {
	test("returns no items without progress rows", () => {
		expect(buildContinueWatching(createData(), 12)).toEqual([]);
	});

	test("builds a movie candidate from in-progress playback", () => {
		const items = buildContinueWatching(
			createData({
				progressRows: [
					{
						mediaFileId: "file-1",
						metadataId: "meta-1",
						movieId: "movie-1",
						episodeId: null,
						position: 600,
						duration: 1200,
						completed: false,
						audioStreamIndex: null,
						subtitleId: null,
						updatedAt: new Date("2026-01-02T00:00:00Z"),
					},
				],
				metadataList: [{ id: "meta-1", title: "Movie", type: "movie" }],
				mediaFiles: [
					{
						id: "file-1",
						metadataId: "meta-1",
						movieId: "movie-1",
						episodeId: null,
						duration: 1200,
						isDefault: true,
						updatedAt: new Date("2026-01-01T00:00:00Z"),
					},
				],
				backdrops: [{ metadataId: "meta-1", imageId: "image-1", imageUpdatedAt: new Date("2026-01-05T00:00:00Z") }],
			}),
			12,
		);

		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({
			mediaFileId: "file-1",
			metadata: { id: "meta-1", title: "Movie", type: "movie" },
			backdropId: "image-1",
			backdropUpdatedAt: new Date("2026-01-05T00:00:00Z"),
			episode: null,
			position: 600,
			progressPercent: 50,
		});
		expect(items[0]).not.toHaveProperty("updatedAt");
	});

	test("skips completed movies", () => {
		const items = buildContinueWatching(
			createData({
				progressRows: [
					{
						mediaFileId: "file-1",
						metadataId: "meta-1",
						movieId: "movie-1",
						episodeId: null,
						position: 1200,
						duration: 1200,
						completed: true,
						audioStreamIndex: null,
						subtitleId: null,
						updatedAt: new Date("2026-01-02T00:00:00Z"),
					},
				],
				metadataList: [{ id: "meta-1", title: "Movie", type: "movie" }],
			}),
			12,
		);

		expect(items).toEqual([]);
	});
});

describe("continue watching builder: most recent active episode", () => {
	test("continues the most recently active episode of a show", () => {
		const items = buildContinueWatching(
			createData({
				progressRows: [
					{
						mediaFileId: "file-2",
						metadataId: "meta-1",
						movieId: null,
						episodeId: "ep-2",
						position: 300,
						duration: 1200,
						completed: false,
						audioStreamIndex: 1,
						subtitleId: null,
						updatedAt: new Date("2026-01-03T00:00:00Z"),
					},
					{
						mediaFileId: "file-1",
						metadataId: "meta-1",
						movieId: null,
						episodeId: "ep-1",
						position: 1200,
						duration: 1200,
						completed: true,
						audioStreamIndex: null,
						subtitleId: null,
						updatedAt: new Date("2026-01-02T00:00:00Z"),
					},
				],
				metadataList: [{ id: "meta-1", title: "Show", type: "tv_show" }],
				mediaFiles: [
					{
						id: "file-1",
						metadataId: "meta-1",
						movieId: null,
						episodeId: "ep-1",
						duration: 1200,
						isDefault: true,
						updatedAt: new Date("2026-01-01T00:00:00Z"),
					},
					{
						id: "file-2",
						metadataId: "meta-1",
						movieId: null,
						episodeId: "ep-2",
						duration: 1200,
						isDefault: true,
						updatedAt: new Date("2026-01-01T00:00:00Z"),
					},
				],
				seasons: [{ id: "season-1", metadataId: "meta-1", seasonNumber: 1 }],
				episodes: [
					{ id: "ep-1", seasonId: "season-1", episodeNumber: 1, absoluteNumber: null, title: "Pilot", episodeType: "regular" },
					{ id: "ep-2", seasonId: "season-1", episodeNumber: 2, absoluteNumber: null, title: "Second", episodeType: "regular" },
				],
			}),
			12,
		);

		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({
			mediaFileId: "file-2",
			metadata: { type: "tv_show" },
			episode: { title: "Second", episodeNumber: 2, seasonNumber: 1 },
			position: 300,
			audioStreamIndex: 1,
		});
	});
});

describe("continue watching builder: next episode after completion", () => {
	test("recommends the next episode when the active one is completed", () => {
		const items = buildContinueWatching(
			createData({
				progressRows: [
					{
						mediaFileId: "file-1",
						metadataId: "meta-1",
						movieId: null,
						episodeId: "ep-1",
						position: 1200,
						duration: 1200,
						completed: true,
						audioStreamIndex: null,
						subtitleId: null,
						updatedAt: new Date("2026-01-02T00:00:00Z"),
					},
				],
				metadataList: [{ id: "meta-1", title: "Show", type: "tv_show" }],
				mediaFiles: [
					{
						id: "file-1",
						metadataId: "meta-1",
						movieId: null,
						episodeId: "ep-1",
						duration: 1200,
						isDefault: true,
						updatedAt: new Date("2026-01-01T00:00:00Z"),
					},
					{
						id: "file-2",
						metadataId: "meta-1",
						movieId: null,
						episodeId: "ep-2",
						duration: 1800,
						isDefault: true,
						updatedAt: new Date("2026-01-01T00:00:00Z"),
					},
				],
				seasons: [{ id: "season-1", metadataId: "meta-1", seasonNumber: 1 }],
				episodes: [
					{ id: "ep-1", seasonId: "season-1", episodeNumber: 1, absoluteNumber: null, title: "Pilot", episodeType: "regular" },
					{ id: "ep-2", seasonId: "season-1", episodeNumber: 2, absoluteNumber: null, title: "Second", episodeType: "regular" },
				],
			}),
			12,
		);

		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({
			mediaFileId: "file-2",
			episode: { title: "Second", episodeNumber: 2 },
			position: 0,
			duration: 1800,
			progressPercent: 0,
		});
	});

	test("sorts candidates by activity and clamps the limit", () => {
		const progressRows = ["meta-1", "meta-2", "meta-3"].map((metadataId, index) => ({
			mediaFileId: `file-${metadataId}`,
			metadataId,
			movieId: `movie-${metadataId}`,
			episodeId: null,
			position: 100,
			duration: 1200,
			completed: false,
			audioStreamIndex: null,
			subtitleId: null,
			updatedAt: new Date(Date.UTC(2026, 0, index + 1)),
		}));
		const metadataList = progressRows.map((row) => ({ id: row.metadataId, title: row.metadataId, type: "movie" as const }));
		const mediaFiles = progressRows.map((row) => ({
			id: row.mediaFileId,
			metadataId: row.metadataId,
			movieId: `movie-${row.metadataId}`,
			episodeId: null,
			duration: 1200,
			isDefault: true,
			updatedAt: new Date("2026-01-01T00:00:00Z"),
		}));
		const data = createData({ progressRows, metadataList, mediaFiles });

		expect(buildContinueWatching(data, 2).map((item) => item.metadata.id)).toEqual(["meta-3", "meta-2"]);
		// A limit below one is raised to one.
		expect(buildContinueWatching(data, 0).map((item) => item.metadata.id)).toEqual(["meta-3"]);
	});
});

describe("continue watching builder: minimum position threshold", () => {
	test("applies the minimum position threshold to movie candidates", () => {
		const progressRows = [
			{
				mediaFileId: "file-1",
				metadataId: "meta-1",
				movieId: "movie-1",
				episodeId: null,
				position: 60,
				duration: 1200,
				completed: false,
				audioStreamIndex: null,
				subtitleId: null,
				updatedAt: new Date("2026-01-02T00:00:00Z"),
			},
		];
		const data = createData({
			progressRows,
			metadataList: [{ id: "meta-1", title: "Movie", type: "movie" }],
			mediaFiles: [
				{
					id: "file-1",
					metadataId: "meta-1",
					movieId: "movie-1",
					episodeId: null,
					duration: 1200,
					isDefault: true,
					updatedAt: new Date("2026-01-01T00:00:00Z"),
				},
			],
		});

		expect(buildContinueWatching(data, 12, 120)).toEqual([]);
		expect(buildContinueWatching(data, 12, 60)).toHaveLength(1);
	});

	test("applies the minimum position threshold to the active episode of a show", () => {
		const data = createData({
			progressRows: [
				{
					mediaFileId: "file-2",
					metadataId: "meta-1",
					movieId: null,
					episodeId: "ep-2",
					position: 300,
					duration: 1200,
					completed: false,
					audioStreamIndex: null,
					subtitleId: null,
					updatedAt: new Date("2026-01-03T00:00:00Z"),
				},
			],
			metadataList: [{ id: "meta-1", title: "Show", type: "tv_show" }],
			mediaFiles: [
				{
					id: "file-2",
					metadataId: "meta-1",
					movieId: null,
					episodeId: "ep-2",
					duration: 1200,
					isDefault: true,
					updatedAt: new Date("2026-01-01T00:00:00Z"),
				},
			],
			seasons: [{ id: "season-1", metadataId: "meta-1", seasonNumber: 1 }],
			episodes: [{ id: "ep-2", seasonId: "season-1", episodeNumber: 2, absoluteNumber: null, title: "Second", episodeType: "regular" }],
		});

		expect(buildContinueWatching(data, 12, 400)).toEqual([]);
		expect(buildContinueWatching(data, 12, 300)).toHaveLength(1);
	});
});

describe("continue watching dismissal", () => {
	const movieData = (progress: Array<{ updatedAt: string; dismissedAt: string | null }>) =>
		createData({
			progressRows: progress.map(({ updatedAt, dismissedAt }) => ({
				mediaFileId: "file-1",
				metadataId: "meta-1",
				movieId: "movie-1",
				episodeId: null,
				position: 600,
				duration: 1200,
				completed: false,
				audioStreamIndex: null,
				subtitleId: null,
				updatedAt: new Date(updatedAt),
				dismissedAt: dismissedAt ? new Date(dismissedAt) : null,
			})),
			metadataList: [{ id: "meta-1", title: "Movie", type: "movie" }],
			mediaFiles: [
				{
					id: "file-1",
					metadataId: "meta-1",
					movieId: "movie-1",
					episodeId: null,
					duration: 1200,
					isDefault: true,
					updatedAt: new Date("2026-01-01T00:00:00Z"),
				},
			],
		});

	test("hides a title dismissed after its last progress write", () => {
		const data = movieData([{ updatedAt: "2026-01-02T00:00:00Z", dismissedAt: "2026-01-03T00:00:00Z" }]);

		expect(buildContinueWatching(data, 12)).toEqual([]);
	});

	test("hides a title whose last progress write is the dismissal itself", () => {
		const data = movieData([{ updatedAt: "2026-01-03T00:00:00Z", dismissedAt: "2026-01-03T00:00:00Z" }]);

		expect(buildContinueWatching(data, 12)).toEqual([]);
	});

	test("stays hidden against the latest of several dismissals", () => {
		const data = movieData([
			{ updatedAt: "2026-01-04T00:00:00Z", dismissedAt: "2026-01-05T00:00:00Z" },
			{ updatedAt: "2026-01-04T00:00:00Z", dismissedAt: "2026-01-03T00:00:00Z" },
		]);

		expect(buildContinueWatching(data, 12)).toEqual([]);
	});

	test("brings the title back once it is played after the dismissal", () => {
		const data = movieData([{ updatedAt: "2026-01-04T00:00:00Z", dismissedAt: "2026-01-03T00:00:00Z" }]);

		expect(buildContinueWatching(data, 12)).toHaveLength(1);
	});

	test("keeps titles that were never dismissed", () => {
		const data = movieData([{ updatedAt: "2026-01-02T00:00:00Z", dismissedAt: null }]);

		expect(buildContinueWatching(data, 12)).toHaveLength(1);
	});
});
