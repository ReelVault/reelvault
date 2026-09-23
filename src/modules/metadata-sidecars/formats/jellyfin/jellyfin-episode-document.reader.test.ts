import { describe, expect, test } from "bun:test";
import { readJellyfinEpisodeDocument } from "./jellyfin-episode-document.reader";

describe("readJellyfinEpisodeDocument", () => {
	test("maps the episode fields with a thumbnail next to the document", async () => {
		const document = await readJellyfinEpisodeDocument({
			documentPath: "/media/Show/Season 01/s01e01.nfo",
			content:
				"<episodedetails><title>Dulcinea</title><aired>2015-12-14</aired><plot>The plot</plot><imdbid>tt1905041</imdbid><thumb>thumb.jpg</thumb></episodedetails>",
		});

		expect(document).toEqual({
			mediaKind: "episode",
			identifiers: { imdb: "tt1905041" },
			title: "Dulcinea",
			releaseDate: "2015-12-14",
			overview: "The plot",
			artwork: { thumbnail: { path: "/media/Show/Season 01/thumb.jpg" } },
		});
	});

	test("re-anchors absolute thumbnails and drops escaping ones", async () => {
		const absolute = await readJellyfinEpisodeDocument({
			documentPath: "/media/Show/Season 01/s01e01.nfo",
			content: "<episodedetails><thumb>/outside/thumb.jpg</thumb></episodedetails>",
		});
		const escaping = await readJellyfinEpisodeDocument({
			documentPath: "/media/Show/Season 01/s01e01.nfo",
			content: "<episodedetails><thumb>../../outside.jpg</thumb></episodedetails>",
		});

		expect(absolute?.artwork.thumbnail).toEqual({ path: "/media/Show/Season 01/thumb.jpg" });
		expect(escaping?.artwork.thumbnail).toBeUndefined();
	});

	test("returns null without an episodedetails root or for malformed XML", async () => {
		expect(await readJellyfinEpisodeDocument({ documentPath: "/media/s01e01.nfo", content: "<movie><title>T</title></movie>" })).toBeNull();
		expect(
			await readJellyfinEpisodeDocument({ documentPath: "/media/s01e01.nfo", content: "<episodedetails><title>broken</episodedetails>" }),
		).toBeNull();
	});

	test("reads Plex-style identifiers and the art poster thumbnail", async () => {
		const document = await readJellyfinEpisodeDocument({
			documentPath: "/media/Show/Season 01/s01e01.nfo",
			content:
				'<episodedetails><title>Nibylandia</title><uniqueid type="imdb">tt13623634</uniqueid><uniqueid type="tvdb">10929566</uniqueid><art><poster>s01e01-thumb.jpg</poster></art></episodedetails>',
		});

		expect(document?.identifiers).toEqual({ imdb: "tt13623634", tvdb: "10929566" });
		expect(document?.artwork.thumbnail).toEqual({ path: "/media/Show/Season 01/s01e01-thumb.jpg" });
	});
});
