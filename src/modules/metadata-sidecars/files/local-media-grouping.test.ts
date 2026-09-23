import { describe, expect, test } from "bun:test";
import type { LocalMovieFolder, LocalSeriesGroup } from "./local-media-grouping";

describe("local media grouping shapes", () => {
	test("a movie folder groups its videos, document, artwork and ignored assets", () => {
		const folder: LocalMovieFolder = {
			movieDirectory: "/media/Movie",
			videoPaths: ["/media/Movie/movie.mkv"],
			documentPath: "/media/Movie/movie.nfo",
			artwork: { poster: { path: "/media/Movie/poster.jpg" } },
			ignoredAssets: [{ path: "/media/Movie/logo.png", fileName: "logo.png", reason: "unsupported-artwork-type" }],
		};

		expect(folder.videoPaths).toHaveLength(1);
		expect(folder.artwork.backdrop).toBeUndefined();
		expect(folder.ignoredAssets[0]?.reason).toBe("unsupported-artwork-type");
	});

	test("a series group nests season groups with episode files", () => {
		const series: LocalSeriesGroup = {
			seriesDirectory: "/media/Show",
			seriesDocument: "/media/Show/tvshow.nfo",
			seasonGroups: [
				{
					seasonNumber: 1,
					seasonDocument: "/media/Show/Season 01/season.nfo",
					episodes: [{ videoPath: "/media/Show/Season 01/s01e01.mkv", episodeNumber: 1 }],
				},
			],
			artwork: {},
		};

		expect(series.seasonGroups[0]?.episodes[0]?.videoPath).toBe("/media/Show/Season 01/s01e01.mkv");
		expect(series.seasonGroups[0]?.poster).toBeUndefined();
		expect(series.seriesDocument).toBe("/media/Show/tvshow.nfo");
	});
});
