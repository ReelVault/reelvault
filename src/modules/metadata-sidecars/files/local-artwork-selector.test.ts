import { describe, expect, test } from "bun:test";
import { indexByLowerCaseName, selectEpisodeThumbnail, selectIgnoredAssets, selectMovieArtwork } from "./local-artwork-selector";

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

	test("prefers backdrop.jpg, then landscape.jpg, then fanart.jpg, then numbered backdrops", () => {
		const withBackdrop = selectMovieArtwork(indexByLowerCaseName(["/backdrop.jpg", "/landscape.jpg", "/fanart.jpg", "/backdrop1.jpg"]));
		expect(withBackdrop.backdrop).toEqual({ path: "/backdrop.jpg" });

		const withFanart = selectMovieArtwork(indexByLowerCaseName(["/fanart.jpg", "/backdrop3.jpg"]));
		expect(withFanart.backdrop).toEqual({ path: "/fanart.jpg" });

		const withLandscape = selectMovieArtwork(indexByLowerCaseName(["/landscape.jpg", "/backdrop3.jpg"]));
		expect(withLandscape.backdrop).toEqual({ path: "/landscape.jpg" });

		const numberedOnly = selectMovieArtwork(indexByLowerCaseName(["/backdrop3.jpg", "/backdrop21.jpg"]));
		expect(numberedOnly.backdrop).toEqual({ path: "/backdrop3.jpg" });
	});

	test("never uses a numbered backdrop for the poster", () => {
		const result = selectMovieArtwork(indexByLowerCaseName(["/backdrop1.jpg"]));
		expect(result.poster).toBeUndefined();
	});

	test("returns undefined entries when nothing matches", () => {
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

	test("returns undefined when the thumbnail is missing", () => {
		expect(selectEpisodeThumbnail("/shows/s01e01.mkv", indexByLowerCaseName(["/folder.jpg"]))).toBeUndefined();
	});
});

describe("selectIgnoredAssets", () => {
	test("flags unsupported artwork files with the path and file name", () => {
		const ignored = selectIgnoredAssets(["/media/banner.png", "/media/clearlogo.png", "/media/logo.jpg", "/media/poster.jpg"]);
		expect(ignored).toEqual([
			{ path: "/media/banner.png", fileName: "banner.png", reason: "unsupported-artwork-type" },
			{ path: "/media/clearlogo.png", fileName: "clearlogo.png", reason: "unsupported-artwork-type" },
			{ path: "/media/logo.jpg", fileName: "logo.jpg", reason: "unsupported-artwork-type" },
		]);
	});

	test("returns nothing for supported artwork", () => {
		expect(selectIgnoredAssets(["/media/folder.jpg", "/media/backdrop.jpg"])).toEqual([]);
	});
});
