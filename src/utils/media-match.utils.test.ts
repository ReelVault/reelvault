import { describe, expect, test } from "bun:test";
import {
	boundedLevenshtein,
	fuzzyTitleDistance,
	generateQueryVariants,
	isSequelMismatch,
	normalizeForFuzzy,
	pickBestMatch,
	rankCandidates,
} from "./media-match.utils";

describe("normalizeForFuzzy", () => {
	test("lowercases and strips diacritics like the FTS tokenizer", () => {
		expect(normalizeForFuzzy("Żółć Łódź")).toBe("zolc lodz");
		expect(normalizeForFuzzy("Incepcja")).toBe("incepcja");
	});
});

describe("boundedLevenshtein", () => {
	test("measures single-character typos", () => {
		expect(boundedLevenshtein("incepion", "inception", 2)).toBe(1);
		expect(boundedLevenshtein("inceptio", "inception", 2)).toBe(1);
	});

	test("returns null once the distance provably exceeds the cap", () => {
		expect(boundedLevenshtein("abcd", "zzzzzz", 2)).toBeNull();
		expect(boundedLevenshtein("star trek", "star wars", 4)).toBe(4);
		expect(boundedLevenshtein("star trek", "star wars", 3)).toBeNull();
	});

	test("handles transpositions as two edits (no Damerau)", () => {
		expect(boundedLevenshtein("teh", "the", 2)).toBe(2);
	});
});

describe("fuzzyTitleDistance", () => {
	test("matches any word of the title", () => {
		expect(fuzzyTitleDistance("incepton", "Inception", 2)).toBe(1);
		expect(fuzzyTitleDistance("warsaw", "Warsaw Pact: Legacy", 2)).toBe(0);
	});

	test("is diacritic-insensitive on both sides", () => {
		expect(fuzzyTitleDistance("żółć", "Żółć żeberka", 1)).toBe(0);
	});

	test("rejects candidates beyond the threshold", () => {
		expect(fuzzyTitleDistance("abcd", "A Quiet Place", 1)).toBeNull();
	});
});

test("picks best match when filename is English and provider title is translated but originalTitle matches", () => {
	const candidates = [
		{
			title: "Skazani na Shawshank",
			originalTitle: "The Shawshank Redemption",
			releaseDate: "1994-09-23",
			popularity: 130,
			voteCount: 26000,
		},
		{
			title: "Shawshank: Za murami",
			originalTitle: "Shawshank: Behind the Walls",
			releaseDate: "2001-05-10",
			popularity: 5,
			voteCount: 12,
		},
	];

	const ranked = rankCandidates(candidates, "The Shawshank Redemption", 1994);
	expect(ranked.length).toBeGreaterThan(0);
	expect(ranked[0]?.item.title).toBe("Skazani na Shawshank");
	expect(ranked[0]?.score).toBeGreaterThan(0.9);

	const bestMatch = pickBestMatch(candidates, "The Shawshank Redemption", 1994);
	expect(bestMatch).toBeDefined();
	expect(bestMatch?.item.title).toBe("Skazani na Shawshank");
});

test("matches English filename for Die Hard with Polish title Szklana pułapka", () => {
	const candidates = [
		{
			title: "Szklana pułapka",
			originalTitle: "Die Hard",
			releaseDate: "1988-07-15",
			popularity: 80,
			voteCount: 11000,
		},
		{
			title: "Szklana pułapka 2",
			originalTitle: "Die Hard 2",
			releaseDate: "1990-07-02",
			popularity: 45,
			voteCount: 5000,
		},
	];

	const bestMatch = pickBestMatch(candidates, "Die Hard", 1988);
	expect(bestMatch).toBeDefined();
	expect(bestMatch?.item.title).toBe("Szklana pułapka");
	expect(bestMatch?.score).toBeGreaterThan(0.9);
});

test("tolerates 1-year discrepancy in release dates", () => {
	const candidates = [
		{
			title: "Incepcja",
			originalTitle: "Inception",
			releaseDate: "2010-07-15",
			popularity: 150,
			voteCount: 35000,
		},
	];

	const ranked = rankCandidates(candidates, "Inception", 2011);
	expect(ranked.length).toBeGreaterThan(0);
	expect(ranked[0]?.score).toBeGreaterThan(0.7);
	expect(ranked[0]?.yearScore).toBe(0.8);
});

test("cleans edition noise from query variants", () => {
	const variants = generateQueryVariants("Blade Runner 2049 Directors Cut");
	expect(variants).toContain("Blade Runner 2049");
});

test("accurately picks Iron Man (2008) over Iron Man 2 and Iron Man 3 even without year", () => {
	const candidates = [
		{
			title: "Iron Man 3",
			originalTitle: "Iron Man 3",
			originalLanguage: "en",
			releaseDate: "2013-04-18",
			popularity: 90,
			voteCount: 22000,
		},
		{
			title: "Iron Man",
			originalTitle: "Iron Man",
			originalLanguage: "en",
			releaseDate: "2008-04-30",
			popularity: 85,
			voteCount: 25000,
		},
		{
			title: "Iron Man 2",
			originalTitle: "Iron Man 2",
			originalLanguage: "en",
			releaseDate: "2010-04-28",
			popularity: 70,
			voteCount: 20000,
		},
	];

	// Without year specified
	const bestWithoutYear = pickBestMatch(candidates, "Iron Man", undefined);
	expect(bestWithoutYear).toBeDefined();
	expect(bestWithoutYear?.item.title).toBe("Iron Man");

	// With year 2008 specified
	const bestWithYear = pickBestMatch(candidates, "Iron Man", 2008);
	expect(bestWithYear).toBeDefined();
	expect(bestWithYear?.item.title).toBe("Iron Man");
});

test("accurately picks Iron Man 3 when searching for Iron Man 3", () => {
	const candidates = [
		{
			title: "Iron Man",
			originalTitle: "Iron Man",
			originalLanguage: "en",
			releaseDate: "2008-04-30",
			popularity: 85,
			voteCount: 25000,
		},
		{
			title: "Iron Man 3",
			originalTitle: "Iron Man 3",
			originalLanguage: "en",
			releaseDate: "2013-04-18",
			popularity: 90,
			voteCount: 22000,
		},
	];

	const bestMatch = pickBestMatch(candidates, "Iron Man 3", 2013);
	expect(bestMatch).toBeDefined();
	expect(bestMatch?.item.title).toBe("Iron Man 3");
});

test("picks Marvel's What If...? over obscure series with identical name", () => {
	const candidates = [
		{
			title: "What If",
			originalTitle: "ホワット・イフ",
			originalLanguage: "ja",
			releaseDate: "1995-04-01",
			popularity: 3,
			voteCount: 12,
		},
		{
			title: "Was wäre wenn...?",
			originalTitle: "What If...?",
			originalLanguage: "en",
			releaseDate: "2021-08-11",
			popularity: 120,
			voteCount: 42000,
		},
	];

	const bestMatch = pickBestMatch(candidates, "What If", undefined);
	expect(bestMatch).toBeDefined();
	expect(bestMatch?.item.title).toBe("Was wäre wenn...?");
});

test("distinguishes Dune from Dune Part Two", () => {
	const candidates = [
		{
			title: "Diuna: Część druga",
			originalTitle: "Dune: Part Two",
			originalLanguage: "en",
			releaseDate: "2024-02-27",
			popularity: 180,
			voteCount: 8000,
		},
		{
			title: "Der Wüstenplanet",
			originalTitle: "Dune",
			originalLanguage: "en",
			releaseDate: "2021-09-15",
			popularity: 140,
			voteCount: 11000,
		},
	];

	const bestMatch = pickBestMatch(candidates, "Dune", 2021);
	expect(bestMatch).toBeDefined();
	expect(bestMatch?.item.title).toBe("Der Wüstenplanet");
});

test("isSequelMismatch correctly respects originalTitle for The Fate of the Furious vs a localized title", () => {
	// The Fate of the Furious is the English title of Fast & Furious 8 (translated as "Rápidos y furiosos 8" in Spanish)
	const candidate = {
		title: "Rápidos y furiosos 8",
		originalTitle: "The Fate of the Furious",
	};

	expect(isSequelMismatch("The Fate of the Furious", candidate)).toBe(false);
	expect(isSequelMismatch("Rápidos y furiosos 8", candidate)).toBe(false);

	// But searching for Furious 7 against Rápidos y furiosos 8 should be a mismatch
	expect(isSequelMismatch("Furious 7", candidate)).toBe(true);

	// Searching for Iron Man (part 1) against Iron Man 3 is a mismatch
	expect(isSequelMismatch("Iron Man", { title: "Iron Man 3", originalTitle: "Iron Man 3" })).toBe(true);
});
