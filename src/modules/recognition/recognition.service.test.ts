import { describe, expect, test } from "bun:test";
import { recognitionService } from "./recognition.service";
import { parseFileName } from "./utils/recognition.utils";

describe("recognition service", () => {
	test("parses series filename directly starting with S02E01", () => {
		const identity = parseFileName("S02E01.mkv");

		expect(identity).toEqual({
			title: "S02E01",
			type: "episode",
			season: 2,
			episode: 1,
		});
	});

	test("parses series filename with episode title after S02E01", () => {
		const identity = parseFileName("S02E01 - Pilot Episode.mkv");

		expect(identity?.type).toBe("episode");
		expect(identity?.season).toBe(2);
		expect(identity?.episode).toBe(1);
	});

	test("recognizes TV show in categorized folder structure (Season 02 / S02E01.mkv)", () => {
		const result = recognitionService.recognize("/media/Series/Breaking Bad (2008)/Season 02/S02E01.mkv");

		expect(result).not.toBeNull();
		expect(result?.type).toBe("tv_show");
		expect(result?.identity.title).toBe("Breaking Bad");
		expect(result?.identity.year).toBe(2008);
		expect(result?.identity.season).toBe(2);
		expect(result?.identity.episode).toBe(1);
	});

	test("recognizes TV show in categorized folder structure with Polish season folder (Sezon 3 / 05.mkv)", () => {
		const result = recognitionService.recognize("/media/Series/The Office (US)/Sezon 3/05 - The Injury.mkv");

		expect(result).not.toBeNull();
		expect(result?.type).toBe("tv_show");
		expect(result?.identity.title).toBe("The Office (US)");
		expect(result?.identity.season).toBe(3);
		expect(result?.identity.episode).toBe(5);
	});

	test("recognizes TV show with short season folder (S1 / Episode 02.mkv)", () => {
		const result = recognitionService.recognize("/media/Series/Severance (2022)/S1/Episode 02.mkv");

		expect(result).not.toBeNull();
		expect(result?.type).toBe("tv_show");
		expect(result?.identity.title).toBe("Severance");
		expect(result?.identity.year).toBe(2022);
		expect(result?.identity.season).toBe(1);
		expect(result?.identity.episode).toBe(2);
	});

	test("recognizes TV show in basic structure (Show Folder / S02E04.mkv)", () => {
		const result = recognitionService.recognize("/media/Series/Breaking Bad (2008)/Breaking.Bad.S02E04.1080p.mkv");

		expect(result).not.toBeNull();
		expect(result?.type).toBe("tv_show");
		expect(result?.identity.title).toBe("Breaking Bad");
		expect(result?.identity.year).toBe(2008);
		expect(result?.identity.season).toBe(2);
		expect(result?.identity.episode).toBe(4);
	});

	test("recognizes TV show with dots in folder name (Married.with.Children / Season 07 / Episode.mkv)", () => {
		const result = recognitionService.recognize(
			"/mnt/tvseries_1/1987/Married.with.Children/Season 07/Married.with.Children.S07E22.Til.Death.Do.Us.Part.mkv",
		);

		expect(result).not.toBeNull();
		expect(result?.type).toBe("tv_show");
		expect(result?.identity.title).toBe("Married with Children");
		expect(result?.identity.season).toBe(7);
		expect(result?.identity.episode).toBe(22);
	});

	test("recognizes TV show with year range in filename", () => {
		const identity = parseFileName("Czterej.Pancerni.I.Pies.1966-1970.S00E04.x264.mkv");

		expect(identity).not.toBeNull();
		expect(identity?.title).toBe("Czterej Pancerni I Pies");
		expect(identity?.year).toBe(1966);
		expect(identity?.season).toBe(0);
		expect(identity?.episode).toBe(4);
	});

	test("recognizes movie in year-bucket folder (/mnt/movies/2010/Inception.2010.mkv)", () => {
		const result = recognitionService.recognize("/mnt/movies/2010/Inception.2010.mkv");

		expect(result).not.toBeNull();
		expect(result?.type).toBe("movie");
		expect(result?.identity.title).toBe("Inception");
		expect(result?.identity.year).toBe(2010);
	});

	test("recognizes movie with full scene tags in generic /movies/ folder without taking folder as title", () => {
		const result = recognitionService.recognize("/mnt/storage/movies/Iron.Man.2008.MULTI.1080p.BluRay.x265.DDP7.1-DENDA.mkv");

		expect(result).not.toBeNull();
		expect(result?.type).toBe("movie");
		expect(result?.identity.title).toBe("Iron Man");
		expect(result?.identity.year).toBe(2008);
	});

	test("recognizes movie in named movie folder with year preserved from filename", () => {
		const result = recognitionService.recognize("/mnt/storage/Filmy/Iron Man/Iron.Man.2008.MULTI.1080p.BluRay.x265.DDP7.1-DENDA.mkv");

		expect(result).not.toBeNull();
		expect(result?.type).toBe("movie");
		expect(result?.identity.title).toBe("Iron Man");
		expect(result?.identity.year).toBe(2008);
	});

	test("strips scene noise on fallback movie when no year is in filename", () => {
		const identity = parseFileName("Iron.Man.MULTI.1080p.BluRay.x265.DDP7.1-DENDA.mkv");

		expect(identity).not.toBeNull();
		expect(identity?.type).toBe("movie");
		expect(identity?.title).toBe("Iron Man");
	});

	test("parses a year in parentheses before the episode marker without leaking it into the title", () => {
		const identity = parseFileName("Breaking Bad (2008) S01E01.mkv");

		expect(identity).not.toBeNull();
		expect(identity?.type).toBe("episode");
		expect(identity?.title).toBe("Breaking Bad");
		expect(identity?.year).toBe(2008);
		expect(identity?.season).toBe(1);
		expect(identity?.episode).toBe(1);
	});

	test("recognizes categorized episode whose filename repeats the show year in parentheses", () => {
		const result = recognitionService.recognize("/media/Series/Breaking Bad (2008)/Season 02/Breaking Bad (2008) S02E01.mkv");

		expect(result).not.toBeNull();
		expect(result?.type).toBe("tv_show");
		expect(result?.identity.title).toBe("Breaking Bad");
		expect(result?.identity.year).toBe(2008);
		expect(result?.identity.season).toBe(2);
		expect(result?.identity.episode).toBe(1);
	});

	test("keeps the show folder title and year when the episode filename carries a later season year", () => {
		const result = recognitionService.recognize("/media/Series/Mr. Robot (2015)/Season 04/Mr. Robot (2019) S04E01.mkv");

		expect(result).not.toBeNull();
		expect(result?.type).toBe("tv_show");
		expect(result?.identity.title).toBe("Mr Robot");
		expect(result?.identity.year).toBe(2015);
		expect(result?.identity.season).toBe(4);
		expect(result?.identity.episode).toBe(1);
	});
});
