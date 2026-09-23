import { describe, expect, test } from "bun:test";
import type { ProviderMetadataResult } from "@reelvault/sdk/plugin";
import { mergeProviderMetadata, type ProviderContribution } from "./metadata-aggregator";

function contribution(providerId: string, metadata: Partial<ProviderMetadataResult>): ProviderContribution {
	return {
		providerId,
		externalId: `${providerId}-id`,
		matchScore: 1,
		metadata: {
			externalId: `${providerId}-id`,
			title: `${providerId} title`,
			releaseDate: "2025-01-01",
			...metadata,
		},
	};
}

describe("mergeProviderMetadata", () => {
	test("scalars come from the highest-priority provider and gaps are filled by lower priority", () => {
		const merged = mergeProviderMetadata([
			contribution("tmdb", { title: "Until Dawn", overview: "", tagline: undefined }),
			contribution("imdb", { title: "Until Dawn (IMDb)", overview: "IMDb plot", tagline: "IMDb tagline" }),
		]);

		expect(merged.primaryProviderId).toBe("tmdb");
		expect(merged.metadata.title).toBe("Until Dawn");
		expect(merged.metadata.overview).toBe("IMDb plot");
		expect(merged.metadata.tagline).toBe("IMDb tagline");
	});

	test("relation arrays are not unioned — the highest-priority non-empty list wins", () => {
		const merged = mergeProviderMetadata([
			contribution("tmdb", { genres: [] }),
			contribution("imdb", { genres: [{ id: "g1", name: "Horror" }] }),
		]);

		expect(merged.metadata.genres).toEqual([{ id: "g1", name: "Horror" }]);
	});

	test("ratings are unioned across providers and de-duplicated by source", () => {
		const merged = mergeProviderMetadata([
			contribution("tmdb", {
				ratings: [{ source: "tmdb", label: "TMDB", value: 7.1, maxValue: 10, votes: 1200 }],
			}),
			contribution("imdb", {
				ratings: [
					{ source: "imdb", label: "IMDb", value: 5.7, maxValue: 10, votes: 61557 },
					{ source: "rottentomatoes", label: "Rotten Tomatoes", value: 52, maxValue: 100 },
					{ source: "metacritic", label: "Metacritic", value: 47, maxValue: 100 },
				],
			}),
		]);

		expect(merged.metadata.ratings?.map((rating) => rating.source)).toEqual(["tmdb", "imdb", "rottentomatoes", "metacritic"]);
	});

	test("a duplicate source keeps the highest-priority provider's rating", () => {
		const merged = mergeProviderMetadata([
			contribution("tmdb", { ratings: [{ source: "imdb", value: 9.9, maxValue: 10 }] }),
			contribution("imdb", { ratings: [{ source: "imdb", value: 5.7, maxValue: 10 }] }),
		]);

		expect(merged.metadata.ratings).toEqual([{ source: "imdb", value: 9.9, maxValue: 10 }]);
	});

	test("synthesizes a rating from the legacy voteAverage when no ratings are provided", () => {
		const merged = mergeProviderMetadata([contribution("tmdb", { voteAverage: 7.5, voteCount: 100 })]);

		expect(merged.metadata.ratings).toEqual([{ source: "tmdb", value: 7.5, maxValue: 10, votes: 100 }]);
	});

	test("lists every linked provider in priority order", () => {
		const merged = mergeProviderMetadata([contribution("tmdb", {}), contribution("imdb", {})]);

		expect(merged.providers.map((provider) => provider.providerId)).toEqual(["tmdb", "imdb"]);
	});
});
