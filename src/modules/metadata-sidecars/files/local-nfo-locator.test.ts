import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { locateLocalNfoChain } from "./local-nfo-locator";

const root = join(tmpdir(), `reelvault-nfo-locator-${process.pid}`);
const movieDir = join(root, "Backrooms (2026)");
const seriesDir = join(root, "Alien Earth (2025)");
const seasonDir = join(seriesDir, "Season 01");

beforeAll(() => {
	mkdirSync(movieDir, { recursive: true });
	mkdirSync(seasonDir, { recursive: true });
	writeFileSync(join(movieDir, "backrooms.2026.mkv"), "x");
	writeFileSync(join(movieDir, "movie.nfo"), "x");
	writeFileSync(join(seriesDir, "tvshow.nfo"), "x");
	writeFileSync(join(seasonDir, "season01.nfo"), "x");
	writeFileSync(join(seasonDir, "E01.nfo"), "x");
	writeFileSync(join(seasonDir, "E01.mkv"), "x");
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("locateLocalNfoChain", () => {
	test("finds basename.nfo before movie.nfo next to a film", async () => {
		writeFileSync(join(movieDir, "backrooms.2026.nfo"), "x");

		const chain = await locateLocalNfoChain(join(movieDir, "backrooms.2026.mkv"), "movie");

		expect(chain.movieDocument).toBe(join(movieDir, "backrooms.2026.nfo"));
		rmSync(join(movieDir, "backrooms.2026.nfo"));
	});

	test("falls back to movie.nfo", async () => {
		const chain = await locateLocalNfoChain(join(movieDir, "backrooms.2026.mkv"), "movie");

		expect(chain.movieDocument).toBe(join(movieDir, "movie.nfo"));
	});

	test("walks the episode chain: sibling, season and series documents", async () => {
		const chain = await locateLocalNfoChain(join(seasonDir, "E01.mkv"), "tv_show");

		expect(chain.episodeDocument).toBe(join(seasonDir, "E01.nfo"));
		expect(chain.seasonDocument).toBe(join(seasonDir, "season01.nfo"));
		expect(chain.seriesDocument).toBe(join(seriesDir, "tvshow.nfo"));
	});

	test("accepts the unpadded season.nfo next to the episodes", async () => {
		const seasonTwoDir = join(seriesDir, "Season 02");
		mkdirSync(seasonTwoDir, { recursive: true });
		writeFileSync(join(seasonTwoDir, "season.nfo"), "x");
		writeFileSync(join(seasonTwoDir, "E01.mkv"), "x");

		const chain = await locateLocalNfoChain(join(seasonTwoDir, "E01.mkv"), "tv_show");

		expect(chain.seasonDocument).toBe(join(seasonTwoDir, "season.nfo"));
		expect(chain.seriesDocument).toBe(join(seriesDir, "tvshow.nfo"));
		rmSync(seasonTwoDir, { recursive: true, force: true });
	});

	test("returns empty entries when no sidecars exist", async () => {
		const chain = await locateLocalNfoChain(join(root, "nothing.mkv"), "movie");

		expect(chain.movieDocument).toBeUndefined();
	});
});
