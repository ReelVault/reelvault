import { describe, expect, test } from "bun:test";
import { readJellyfinSeasonDocument } from "./jellyfin-season-document.reader";

describe("readJellyfinSeasonDocument", () => {
	test("maps the season title, airdate and local poster", async () => {
		const document = await readJellyfinSeasonDocument({
			documentPath: "/media/Alien/Season 01/season01.nfo",
			content:
				"<season><title>Season One</title><premiered>2025-08-12</premiered><plot>The first batch.</plot><thumb>season01-poster.jpg</thumb></season>",
		});

		expect(document).toEqual({
			mediaKind: "season",
			identifiers: {},
			title: "Season One",
			releaseDate: "2025-08-12",
			overview: "The first batch.",
			artwork: { poster: { path: "/media/Alien/Season 01/season01-poster.jpg" } },
		});
	});

	test("returns null without a season root", async () => {
		expect(await readJellyfinSeasonDocument({ documentPath: "/x/season01.nfo", content: "<tvshow><title>T</title></tvshow>" })).toBeNull();
	});

	test("reads the Jellyfin art poster and tvdb identifier", async () => {
		const document = await readJellyfinSeasonDocument({
			documentPath: "/media/Alien/Season 01/season.nfo",
			content: "<season><title>Sezon 1</title><tvdbid>2165857</tvdbid><art><poster>/mnt/old/season01-poster.jpg</poster></art></season>",
		});

		expect(document?.identifiers).toEqual({ tvdb: "2165857" });
		expect(document?.artwork.poster).toEqual({ path: "/media/Alien/Season 01/season01-poster.jpg" });
	});
});
