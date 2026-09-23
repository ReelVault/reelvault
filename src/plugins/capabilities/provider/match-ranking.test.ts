import { describe, expect, test } from "bun:test";
import type { ProviderMetadataResult } from "@sdk/plugin";
import { discoveryCacheKey, matchesExternalIdentifiers, normalizeMetadataDetails, trimNameAndOverview } from "./match-ranking";

function metadataFixture(): ProviderMetadataResult {
	return {
		externalId: "m1",
		title: "  Movie  ",
		originalTitle: " Movie ",
		overview: " Text ",
		tagline: " Tag ",
		releaseDate: "2020-01-01",
		revenue: 0,
		genres: [{ id: "1", name: " Drama " }],
		keywords: [{ id: "2", name: " Space " }],
		cast: [
			{ id: "c2", character: "Lead", name: "B", role: "Lead", order: 2 },
			{ id: "c0", character: "Cut", name: "", role: "Cut", order: 0 },
			{ id: "c1", character: "Support", name: "A", role: "Support", order: 1 },
		],
	};
}

describe("trimNameAndOverview", () => {
	test("trims name and overview without touching other fields", () => {
		const trimmed = trimNameAndOverview({ name: "  Studio  ", overview: "  Plot.  ", id: "x" });

		expect(trimmed.name).toBe("Studio");
		expect(trimmed.overview).toBe("Plot.");
		expect(trimmed.id).toBe("x");
	});
});

describe("normalizeMetadataDetails", () => {
	test("trims strings, drops non-positive revenue and sorts cast by order", () => {
		const normalized = normalizeMetadataDetails(metadataFixture());

		expect(normalized.title).toBe("Movie");
		expect(normalized.revenue).toBeUndefined();
		expect(normalized.genres?.[0]?.name).toBe("Drama");
		expect(normalized.cast?.map((member) => member.name)).toEqual(["A", "B"]);
	});
});

describe("discoveryCacheKey", () => {
	test("keys differ when request discriminants differ", () => {
		const base = { type: "movie" as const, category: "popular" as const };
		expect(discoveryCacheKey(base)).not.toBe(discoveryCacheKey({ ...base, page: 2 }));
		expect(discoveryCacheKey(base)).toBe(discoveryCacheKey({ ...base }));
	});
});

describe("matchesExternalIdentifiers", () => {
	test("accepts when the provider owns the namespace or the id matches", () => {
		expect(matchesExternalIdentifiers("tmdb", { ...metadataFixture(), externalId: "other" }, { tmdb: "1" }, new Set())).toBeTrue();
		expect(matchesExternalIdentifiers("imdb", { ...metadataFixture(), externalId: "tt123" }, {}, new Set(["tt123"]))).toBeTrue();
		expect(matchesExternalIdentifiers("tmdb", { ...metadataFixture(), externalId: "other" }, {}, new Set(["tt123"]))).toBeFalse();
		expect(matchesExternalIdentifiers("tmdb", { ...metadataFixture(), externalId: "" }, { tmdb: "1" }, new Set())).toBeFalse();
	});
});
