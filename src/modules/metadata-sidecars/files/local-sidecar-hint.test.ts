import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSidecarMetadataHint } from "./local-sidecar-hint";

const root = join(tmpdir(), `reelvault-nfo-hint-${process.pid}`);
const movieDir = join(root, "Backrooms (2026)");
const seriesDir = join(root, "Alien Earth (2025)");
const seasonDir = join(seriesDir, "Season 01");

const MOVIE_NFO = `<movie>
	<title>Backrooms</title>
	<originaltitle>The Backrooms</originaltitle>
	<year>2026</year>
	<premiered>2026-01-15</premiered>
	<plot>Found footage.</plot>
	<imdb_id>tt0123456</imdb_id>
	<tmdbid>42424</tmdbid>
	<genre>Horror</genre>
	<genre>Mystery</genre>
	<ratings><rating name="imdb"><value>7.5</value><votes>1200</votes></rating></ratings>
	<art><poster>folder.jpg</poster><fanart>backdrop.jpg</fanart></art>
</movie>`;

const TVSHOW_NFO = `<tvshow>
	<title>Obcy: Ziemia</title>
	<year>2025</year>
	<imdbid>tt21058606</imdbid>
	<art><poster>folder.jpg</poster></art>
</tvshow>`;

const SEASON_NFO = `<season>
	<title>Season One</title>
	<premiered>2025-08-12</premiered>
	<thumb>season01-poster.jpg</thumb>
</season>`;

const EPISODE_NFO = `<episodedetails>
	<title>In Space, No One…</title>
	<aired>2025-08-12</aired>
	<imdbid>tt1001</imdbid>
	<thumb>e03-thumb.jpg</thumb>
</episodedetails>`;

beforeAll(() => {
	mkdirSync(movieDir, { recursive: true });
	mkdirSync(seasonDir, { recursive: true });
	writeFileSync(join(movieDir, "movie.nfo"), MOVIE_NFO);
	writeFileSync(join(movieDir, "folder.jpg"), "x");
	writeFileSync(join(movieDir, "backdrop.jpg"), "x");
	writeFileSync(join(seriesDir, "tvshow.nfo"), TVSHOW_NFO);
	writeFileSync(join(seriesDir, "folder.jpg"), "x");
	writeFileSync(join(seasonDir, "season01.nfo"), SEASON_NFO);
	writeFileSync(join(seasonDir, "season01-poster.jpg"), "x");
	writeFileSync(join(seasonDir, "e03.nfo"), EPISODE_NFO);
	writeFileSync(join(seasonDir, "e03-thumb.jpg"), "x");
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("readSidecarMetadataHint", () => {
	test("reads the movie document including the underscore imdb_id variant", async () => {
		const hint = await readSidecarMetadataHint(join(movieDir, "Backrooms.2026.mkv"), "movie");

		expect(hint?.identifiers).toEqual({ imdb: "tt0123456", tmdb: "42424" });
		expect(hint?.title).toBe("Backrooms");
		expect(hint?.year).toBe(2026);
		expect(hint?.genres).toEqual(["Horror", "Mystery"]);
		expect(hint?.posterPath).toBe(join(movieDir, "folder.jpg"));
		expect(hint?.backdropPath).toBe(join(movieDir, "backdrop.jpg"));
	});

	test("merges series, season and episode documents for a tv_show file", async () => {
		const hint = await readSidecarMetadataHint(join(seasonDir, "e03.mkv"), "tv_show");

		expect(hint?.identifiers).toEqual({ imdb: "tt21058606" });
		expect(hint?.title).toBe("Obcy: Ziemia");
		expect(hint?.posterPath).toBe(join(seriesDir, "folder.jpg"));
		expect(hint?.seasonName).toBe("Season One");
		expect(hint?.seasonPosterPath).toBe(join(seasonDir, "season01-poster.jpg"));
		expect(hint?.episodeName).toBe("In Space, No One…");
		expect(hint?.episodeThumbnailPath).toBe(join(seasonDir, "e03-thumb.jpg"));
	});

	test("returns undefined for a file without sidecar documents", async () => {
		writeFileSync(join(root, "lonely.mkv"), "x");

		await expect(readSidecarMetadataHint(join(root, "lonely.mkv"), "movie")).resolves.toBeUndefined();
	});
});
