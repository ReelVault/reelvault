import { describe, expect, test } from "bun:test";
import { mapJellyfinArtwork } from "./jellyfin-artwork.mapper";

describe("mapJellyfinArtwork", () => {
	test("resolves relative poster and fanart next to the document", () => {
		const artwork = mapJellyfinArtwork("/media/Movie/movie.nfo", {
			art: { poster: "folder.jpg", fanart: "backdrops/fanart.jpg" },
		});

		expect(artwork.poster).toEqual({ path: "/media/Movie/folder.jpg" });
		expect(artwork.backdrop).toEqual({ path: "/media/Movie/backdrops/fanart.jpg" });
	});

	test("re-anchors absolute artwork references to the document directory", () => {
		const artwork = mapJellyfinArtwork("/media/Movie/movie.nfo", { art: { poster: "/mnt/old-server/Backrooms (2026)/poster.jpg" } });

		expect(artwork.poster).toEqual({ path: "/media/Movie/poster.jpg" });
	});

	test("drops artwork paths escaping the movie directory", () => {
		const artwork = mapJellyfinArtwork("/media/Movie/movie.nfo", { art: { fanart: "../../outside.jpg" } });

		expect(artwork.backdrop).toBeUndefined();
	});

	test("a document without an art element yields no artwork", () => {
		expect(mapJellyfinArtwork("/media/Movie/movie.nfo", { title: "T" })).toEqual({});
	});

	test("reads the Kodi/Plex thumb and fanart elements", () => {
		const artwork = mapJellyfinArtwork("/media/Movie/movie.nfo", {
			thumb: { "@_aspect": "poster", "#text": "poster.jpg" },
			fanart: { thumb: "backdrop.jpg" },
		});

		expect(artwork.poster).toEqual({ path: "/media/Movie/poster.jpg" });
		expect(artwork.backdrop).toEqual({ path: "/media/Movie/backdrop.jpg" });
	});

	test("accepts a bare thumb as the poster and rejects remote URLs", () => {
		const artwork = mapJellyfinArtwork("/media/Movie/movie.nfo", {
			thumb: "https://image.tmdb.org/poster.jpg",
			fanart: { thumb: "https://image.tmdb.org/backdrop.jpg" },
		});

		expect(artwork).toEqual({});
	});
});
