import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { write } from "bun";
import { JellyfinFormatAdapter } from "./jellyfin-format.adapter";

test("Jellyfin movie adapter recognizes and reads a movie document", async () => {
	const directory = await mkdtemp(join(tmpdir(), "reelvault-jellyfin-"));
	const documentPath = join(directory, "movie.nfo");
	await write(
		documentPath,
		'\uFEFF<?xml version="1.0"?><movie><title>Tom &amp; Jerry</title><originaltitle>Original</originaltitle><year>2013</year><premiered>2013-05-24</premiered><plot>A &lt; B</plot><imdbid>tt1905041</imdbid><tmdbid>82992</tmdbid><art><poster>folder.jpg</poster><fanart>backdrop.jpg</fanart></art></movie>',
	);

	try {
		const adapter = new JellyfinFormatAdapter();
		expect(await adapter.canRead({ documentPath })).toBeTrue();
		expect(await adapter.read({ documentPath })).toMatchObject({
			mediaKind: "movie",
			title: "Tom & Jerry",
			year: 2013,
			overview: "A < B",
			identifiers: { imdb: "tt1905041", tmdb: "82992" },
			artwork: { poster: { path: join(directory, "folder.jpg") }, backdrop: { path: join(directory, "backdrop.jpg") } },
		});
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
});

test("Jellyfin movie adapter drops malformed identifiers and external artwork paths", async () => {
	const directory = await mkdtemp(join(tmpdir(), "reelvault-jellyfin-"));
	const documentPath = join(directory, "movie.nfo");
	await write(
		documentPath,
		"<movie><title>Arrival</title><imdbid>invalid</imdbid><tmdbid>tmdb:329865</tmdbid><art><poster>/outside/poster.jpg</poster><fanart>../outside.jpg</fanart></art></movie>",
	);

	try {
		const document = await new JellyfinFormatAdapter().read({ documentPath });
		expect(document).toMatchObject({ identifiers: {}, artwork: {} });
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
});

test("Jellyfin movie adapter rejects malformed XML", async () => {
	const directory = await mkdtemp(join(tmpdir(), "reelvault-jellyfin-"));
	const documentPath = join(directory, "movie.nfo");
	await write(documentPath, "<movie><title>broken</movie>");

	try {
		expect(await new JellyfinFormatAdapter().read({ documentPath })).toBeNull();
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
});

test("Jellyfin adapter reads series and episode documents", async () => {
	const directory = await mkdtemp(join(tmpdir(), "reelvault-jellyfin-"));
	const seriesPath = join(directory, "tvshow.nfo");
	const episodePath = join(directory, "Episode 01.nfo");
	await Promise.all([
		write(seriesPath, "<tvshow><title>The Expanse</title><tmdbid>1408</tmdbid></tvshow>"),
		write(episodePath, "<episodedetails><title>Dulcinea</title><plot>Episode plot</plot></episodedetails>"),
	]);

	try {
		const adapter = new JellyfinFormatAdapter();
		expect(await adapter.read({ documentPath: seriesPath })).toMatchObject({ mediaKind: "series", title: "The Expanse" });
		expect(await adapter.read({ documentPath: episodePath })).toMatchObject({ mediaKind: "episode", title: "Dulcinea" });
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
});
