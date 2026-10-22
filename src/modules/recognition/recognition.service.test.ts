import { describe, expect, test } from "bun:test";
import { recognitionService } from "./recognition.service";

describe("recognition service", () => {
	test("recognizes TV show in categorized folder structure (Season 02 / S02E01.mkv)", () => {
		const result = recognitionService.recognize("/media/Series/Breaking Bad (2008)/Season 02/S02E01.mkv");

		expect(result).not.toBeNull();
		expect(result?.type).toBe("tv_show");
		expect(result?.identity.title).toBe("Breaking Bad");
		expect(result?.identity.year).toBe(2008);
		expect(result?.identity.season).toBe(2);
		expect(result?.identity.episode).toBe(1);
	});

	test("recognizes TV show in categorized folder structure with Polish season folder (Sezon 3 / 05 - The Injury.mkv)", () => {
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

	test("recognizes TV show in basic structure (Breaking Bad (2008) / Breaking.Bad.S02E04.1080p.mkv)", () => {
		const result = recognitionService.recognize("/media/Series/Breaking Bad (2008)/Breaking.Bad.S02E04.1080p.mkv");

		expect(result).not.toBeNull();
		expect(result?.type).toBe("tv_show");
		expect(result?.identity.title).toBe("Breaking Bad");
		expect(result?.identity.year).toBe(2008);
		expect(result?.identity.season).toBe(2);
		expect(result?.identity.episode).toBe(4);
	});

	test("recognizes TV show with dots in folder name (Married.with.Children / Season 07 / S07E22 release name)", () => {
		const result = recognitionService.recognize(
			"/mnt/tvseries_1/1987/Married.with.Children/Season 07/Married.with.Children.S07E22.Til.Death.Do.Us.Part.mkv",
		);

		expect(result).not.toBeNull();
		expect(result?.type).toBe("tv_show");
		expect(result?.identity.title).toBe("Married with Children");
		expect(result?.identity.season).toBe(7);
		expect(result?.identity.episode).toBe(22);
	});
});

describe("recognition service: movie in a year-bucket folder", () => {
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

	test("recognizes a basic-structure file whose SxxExx marker has no separator before it", () => {
		const result = recognitionService.recognize("/media/Series/Friends (1994)/xS01E01.mkv");

		expect(result).not.toBeNull();
		expect(result?.type).toBe("tv_show");
		expect(result?.identity.season).toBe(1);
		expect(result?.identity.episode).toBe(1);
	});
});

describe("recognition service: bare episode number", () => {
	test("classifies a bare episode number in a basic structure as a movie with no season or episode", () => {
		const result = recognitionService.recognize("/media/Series/Friends (1994)/Friends - 01.mkv");

		expect(result?.type).toBe("movie");
		expect(result?.identity.season).toBeUndefined();
		expect(result?.identity.episode).toBeUndefined();
	});

	test("recognizes a basic-structure episode in a generic folder without taking the folder as the show title", () => {
		const result = recognitionService.recognize("/mnt/storage/movies/Example.Show.2019.S01E03.mkv");

		expect(result?.type).toBe("tv_show");
		expect(result?.identity.title).toBe("Example Show");
		expect(result?.identity.year).toBe(2019);
		expect(result?.identity.season).toBe(1);
		expect(result?.identity.episode).toBe(3);
	});

	test("recognizes a basic-structure episode in a TV root folder", () => {
		const result = recognitionService.recognize("/media/TV Shows/Example.Show.S01E03.mkv");

		expect(result?.type).toBe("tv_show");
		expect(result?.identity.title).toBe("Example Show");
	});
});
