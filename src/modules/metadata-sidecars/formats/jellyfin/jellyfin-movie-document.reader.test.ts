import { describe, expect, test } from "bun:test";
import { readJellyfinMovieDocument } from "./jellyfin-movie-document.reader";

describe("readJellyfinMovieDocument", () => {
	test("maps the movie fields, identifiers and artwork", async () => {
		const document = await readJellyfinMovieDocument({
			documentPath: "/media/Movie/movie.nfo",
			content:
				"<movie><title>Tom &amp; Jerry</title><originaltitle>Original</originaltitle><year>2013</year><premiered>2013-05-24</premiered><plot>The plot</plot><tagline>The tagline</tagline><status>Released</status><imdbid>tt1905041</imdbid><tmdbid>82992</tmdbid><art><poster>folder.jpg</poster></art></movie>",
		});

		expect(document).toEqual({
			mediaKind: "movie",
			identifiers: { imdb: "tt1905041", tmdb: "82992" },
			title: "Tom & Jerry",
			originalTitle: "Original",
			year: 2013,
			releaseDate: "2013-05-24",
			overview: "The plot",
			tagline: "The tagline",
			status: "Released",
			artwork: { poster: { path: "/media/Movie/folder.jpg" } },
		});
	});

	test("drops malformed identifiers and invalid years", async () => {
		const document = await readJellyfinMovieDocument({
			documentPath: "/media/Movie/movie.nfo",
			content: "<movie><title>Arrival</title><imdbid>invalid</imdbid><tmdbid>tmdb:329865</tmdbid><year>not-a-year</year></movie>",
		});

		expect(document?.identifiers).toEqual({});
		expect(document?.year).toBeUndefined();
	});

	test("accepts the underscore imdb_id variant and library-quality fields", async () => {
		const document = await readJellyfinMovieDocument({
			documentPath: "/media/Movie/movie.nfo",
			content:
				"<movie><title>Alien</title><imdb_id>tt0123456</imdb_id><genre>Horror</genre><runtime>117</runtime><actor><name>Sigourney Weaver</name><role>Ripley</role><order>0</order></actor></movie>",
		});

		expect(document?.identifiers).toEqual({ imdb: "tt0123456" });
		expect(document?.genres).toEqual(["Horror"]);
		expect(document?.runtimeMinutes).toBe(117);
		expect(document?.cast).toEqual([{ name: "Sigourney Weaver", character: "Ripley", order: 0 }]);
	});

	test("returns null without a movie root or for malformed XML", async () => {
		expect(
			await readJellyfinMovieDocument({ documentPath: "/media/Movie/movie.nfo", content: "<tvshow><title>T</title></tvshow>" }),
		).toBeNull();
		expect(await readJellyfinMovieDocument({ documentPath: "/media/Movie/movie.nfo", content: "<movie><title>broken</movie>" })).toBeNull();
	});

	test("reads the Kodi/Plex uniqueid and typed id elements", async () => {
		const document = await readJellyfinMovieDocument({
			documentPath: "/media/Movie/movie.nfo",
			content:
				'<movie><uniqueid type="imdb" default="true">tt1375666</uniqueid><uniqueid type="tmdb">27205</uniqueid><uniqueid type="tvdb">121361</uniqueid></movie>',
		});

		expect(document?.identifiers).toEqual({ imdb: "tt1375666", tmdb: "27205", tvdb: "121361" });
	});

	test("maps the legacy id element via tt-prefix or moviedb attribute, dropping bare digits", async () => {
		const typed = await readJellyfinMovieDocument({
			documentPath: "/media/Movie/movie.nfo",
			content: '<movie><id moviedb="tmdb">27205</id></movie>',
		});
		const imdb = await readJellyfinMovieDocument({ documentPath: "/media/Movie/movie.nfo", content: "<movie><id>tt1375666</id></movie>" });
		const bare = await readJellyfinMovieDocument({ documentPath: "/media/Movie/movie.nfo", content: "<movie><id>27205</id></movie>" });

		expect(typed?.identifiers).toEqual({ tmdb: "27205" });
		expect(imdb?.identifiers).toEqual({ imdb: "tt1375666" });
		expect(bare?.identifiers).toEqual({});
	});

	test("reads rating sources from attributes and the ratings wrapper", async () => {
		const document = await readJellyfinMovieDocument({
			documentPath: "/media/Movie/movie.nfo",
			content:
				'<movie><ratings><rating name="imdb" max="10" default="true"><value>8.5</value><votes>24000</votes></rating><rating name="themoviedb"><value>7.9</value></rating></ratings></movie>',
		});

		expect(document?.ratings).toEqual([
			{ source: "imdb", value: 8.5, voteCount: 24000 },
			{ source: "themoviedb", value: 7.9 },
		]);
	});

	test("falls back to Jellyfin's bare text rating and keeps child-element ratings working", async () => {
		const bare = await readJellyfinMovieDocument({
			documentPath: "/media/Movie/movie.nfo",
			content: "<movie><rating>7.066</rating></movie>",
		});
		const childElement = await readJellyfinMovieDocument({
			documentPath: "/media/Movie/movie.nfo",
			content: "<movie><rating><name>imdb</name><value>8.5</value><votes>12</votes></rating></movie>",
		});

		expect(bare?.ratings).toEqual([{ source: "sidecar", value: 7.066 }]);
		expect(childElement?.ratings).toEqual([{ source: "imdb", value: 8.5, voteCount: 12 }]);
	});

	test("keeps performers in the cast (sortorder) and drops Jellyfin crew actor blocks", async () => {
		const document = await readJellyfinMovieDocument({
			documentPath: "/media/Movie/movie.nfo",
			content:
				"<movie><actor><name>Sydney Chandler</name><role>Wendy</role><type>Actor</type><sortorder>0</sortorder></actor><actor><name>Kit Young</name><role>Tootles</role><type>GuestStar</type><sortorder>3</sortorder></actor><actor><name>Ridley Scott</name><role>Executive Producer</role><type>Producer</type></actor><actor><name>No Order</name><role>Cameo</role></actor></movie>",
		});

		expect(document?.cast).toEqual([
			{ name: "Sydney Chandler", character: "Wendy", order: 0 },
			{ name: "Kit Young", character: "Tootles", order: 3 },
			{ name: "No Order", character: "Cameo", order: 3 },
		]);
	});
});
