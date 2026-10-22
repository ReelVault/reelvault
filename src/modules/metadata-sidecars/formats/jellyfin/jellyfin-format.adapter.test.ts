import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { write } from "bun";
import { removeTree } from "@/utils/directory.utils";
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
		await removeTree(directory);
	}
});

test("Jellyfin movie adapter drops identifiers that are not in the provider format", async () => {
	const directory = await mkdtemp(join(tmpdir(), "reelvault-jellyfin-"));
	const documentPath = join(directory, "movie.nfo");
	await write(documentPath, "<movie><title>Arrival</title><imdbid>invalid</imdbid><tmdbid>tmdb:329865</tmdbid></movie>");

	try {
		const document = await new JellyfinFormatAdapter().read({ documentPath });
		expect(document).toMatchObject({ title: "Arrival" });
		expect(document?.identifiers).toEqual({});
	} finally {
		await removeTree(directory);
	}
});

test("Jellyfin movie adapter re-anchors an absolute poster and drops fanart that escapes the movie folder", async () => {
	const directory = await mkdtemp(join(tmpdir(), "reelvault-jellyfin-"));
	const documentPath = join(directory, "movie.nfo");
	await write(
		documentPath,
		"<movie><title>Arrival</title><art><poster>/outside/poster.jpg</poster><fanart>../outside.jpg</fanart></art></movie>",
	);

	try {
		const document = await new JellyfinFormatAdapter().read({ documentPath });
		expect(document?.artwork).toEqual({ poster: { path: join(directory, "poster.jpg") } });
	} finally {
		await removeTree(directory);
	}
});

test("Jellyfin movie adapter rejects malformed XML", async () => {
	const directory = await mkdtemp(join(tmpdir(), "reelvault-jellyfin-"));
	const documentPath = join(directory, "movie.nfo");
	await write(documentPath, "<movie><title>broken</movie>");

	try {
		expect(await new JellyfinFormatAdapter().read({ documentPath })).toBeNull();
	} finally {
		await removeTree(directory);
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
		await removeTree(directory);
	}
});

test("Jellyfin adapter declines the app's own .reelvault.nfo snapshots", async () => {
	const adapter = new JellyfinFormatAdapter();

	expect(await adapter.canRead({ documentPath: "/media/movie.nfo" })).toBeTrue();
	expect(await adapter.canRead({ documentPath: "/media/movie.reelvault.nfo" })).toBeFalse();
	expect(await adapter.canRead({ documentPath: "/media/tvshow.reelvault.nfo" })).toBeFalse();
});
