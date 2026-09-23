import { describe, expect, test } from "bun:test";
import { readJellyfinSeriesDocument } from "./jellyfin-series-document.reader";

describe("readJellyfinSeriesDocument", () => {
	test("maps the series fields, identifiers and artwork", async () => {
		const document = await readJellyfinSeriesDocument({
			documentPath: "/media/Show/tvshow.nfo",
			content:
				"<tvshow><title>The Expanse</title><originaltitle>Original</originaltitle><year>2015</year><premiered>2015-12-14</premiered><plot>The plot</plot><status>Ended</status><tmdbid>1408</tmdbid><art><fanart>fanart.jpg</fanart></art></tvshow>",
		});

		expect(document).toEqual({
			mediaKind: "series",
			identifiers: { tmdb: "1408" },
			title: "The Expanse",
			originalTitle: "Original",
			year: 2015,
			releaseDate: "2015-12-14",
			overview: "The plot",
			status: "Ended",
			artwork: { backdrop: { path: "/media/Show/fanart.jpg" } },
		});
	});

	test("a series document has no tagline field", async () => {
		const document = await readJellyfinSeriesDocument({
			documentPath: "/media/Show/tvshow.nfo",
			content: "<tvshow><title>T</title></tvshow>",
		});

		expect(document).not.toHaveProperty("tagline");
	});

	test("returns null without a tvshow root or for malformed XML", async () => {
		expect(
			await readJellyfinSeriesDocument({ documentPath: "/media/Show/tvshow.nfo", content: "<movie><title>T</title></movie>" }),
		).toBeNull();
		expect(
			await readJellyfinSeriesDocument({ documentPath: "/media/Show/tvshow.nfo", content: "<tvshow><title>broken</tvshow>" }),
		).toBeNull();
	});
});
