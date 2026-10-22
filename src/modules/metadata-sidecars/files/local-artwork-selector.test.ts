import { describe, expect, test } from "bun:test";
import { indexByLowerCaseName, selectEpisodeThumbnail, selectIgnoredAssets, selectMovieArtwork } from "./local-artwork.selector";

describe("indexByLowerCaseName", () => {
	test("indexes file names case-insensitively, keeping the original path", () => {
		const indexed = indexByLowerCaseName(["/media/Folder.JPG", "/media/poster.jpg"]);
		expect(indexed.get("folder.jpg")).toBe("/media/Folder.JPG");
		expect(indexed.get("poster.jpg")).toBe("/media/poster.jpg");
	});

	test("later entries win on name collisions", () => {
		const indexed = indexByLowerCaseName(["/a/poster.jpg", "/b/Poster.JPG"]);
		expect(indexed.get("poster.jpg")).toBe("/b/Poster.JPG");
	});
});

describe("selectMovieArtwork", () => {
	test("prefers folder.jpg over poster.jpg for the poster", () => {
		const result = selectMovieArtwork(indexByLowerCaseName(["/p.jpg", "/folder.jpg", "/poster.jpg"]));
		expect(result.poster).toEqual({ path: "/folder.jpg" });
	});

	test("falls back to poster.jpg when folder.jpg is absent", () => {
		const result = selectMovieArtwork(indexByLowerCaseName(["/poster.jpg"]));
		expect(result.poster).toEqual({ path: "/poster.jpg" });
	});

	test.each([
		{ name: "backdrop.jpg", listed: ["/backdrop.jpg", "/landscape.jpg", "/fanart.jpg", "/backdrop1.jpg"], expected: "/backdrop.jpg" },
		{ name: "landscape.jpg", listed: ["/fanart.jpg", "/landscape.jpg", "/backdrop3.jpg"], expected: "/landscape.jpg" },
		{ name: "fanart.jpg", listed: ["/backdrop3.jpg", "/fanart.jpg"], expected: "/fanart.jpg" },
	])("picks $name ahead of the lower-ranked backdrop candidates", ({ listed, expected }) => {
		expect(selectMovieArtwork(indexByLowerCaseName(listed)).backdrop).toEqual({ path: expected });
	});

	test("picks the lowest-numbered backdrop whatever order the folder lists them in", () => {
		const numbered = ["/backdrop21.jpg", "/backdrop3.jpg", "/backdrop10.jpg"];

		expect(selectMovieArtwork(indexByLowerCaseName(numbered)).backdrop).toEqual({ path: "/backdrop3.jpg" });
		expect(selectMovieArtwork(indexByLowerCaseName([...numbered].toReversed())).backdrop).toEqual({ path: "/backdrop3.jpg" });
	});

	test("never uses a numbered backdrop for the poster", () => {
		const result = selectMovieArtwork(indexByLowerCaseName(["/backdrop1.jpg"]));
		expect(result.poster).toBeUndefined();
	});

	test("returns no poster and no backdrop when the folder holds neither", () => {
		const result = selectMovieArtwork(indexByLowerCaseName(["/video.mkv", "/backdrops.png"]));
		expect(result.poster).toBeUndefined();
		expect(result.backdrop).toBeUndefined();
	});
});

describe("selectEpisodeThumbnail", () => {
	test("matches `<episode basename>-thumb.jpg`", () => {
		const files = indexByLowerCaseName(["/s01e01-thumb.jpg", "/folder.jpg"]);
		expect(selectEpisodeThumbnail("/shows/s01e01.mkv", files)).toEqual({ path: "/s01e01-thumb.jpg" });
	});

	test("finds the thumbnail when the episode file name differs only in case", () => {
		const files = indexByLowerCaseName(["/shows/s01e01-thumb.jpg"]);
		expect(selectEpisodeThumbnail("/shows/S01E01.mkv", files)).toEqual({ path: "/shows/s01e01-thumb.jpg" });
	});

	test("returns undefined when the thumbnail is missing", () => {
		expect(selectEpisodeThumbnail("/shows/s01e01.mkv", indexByLowerCaseName(["/folder.jpg"]))).toBeUndefined();
	});
});

describe("selectIgnoredAssets", () => {
	test("flags banner and logo artwork and leaves posters out", () => {
		const ignored = selectIgnoredAssets(["/media/banner.png", "/media/clearlogo.png", "/media/logo.jpg", "/media/poster.jpg"]);
		expect(ignored).toEqual([
			{ path: "/media/banner.png", fileName: "banner.png", reason: "unsupported-artwork-type" },
			{ path: "/media/clearlogo.png", fileName: "clearlogo.png", reason: "unsupported-artwork-type" },
			{ path: "/media/logo.jpg", fileName: "logo.jpg", reason: "unsupported-artwork-type" },
		]);
	});
});
