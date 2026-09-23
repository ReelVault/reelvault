import { describe, expect, test } from "bun:test";
import type { MetadataCandidate } from "@reelvault/sdk/common";
import type { ProviderMetadataResult } from "@reelvault/sdk/plugin";
import { applyMetadataCandidate, toMetadataCandidate } from "./metadata-normalization";

function providerResult(overrides: Partial<ProviderMetadataResult> = {}): ProviderMetadataResult {
	return {
		externalId: "42",
		title: "Original Title",
		releaseDate: "2026-01-01",
		posterPath: "/poster.jpg",
		backdropPath: "/backdrop.jpg",
		...overrides,
	};
}

function candidate(overrides: Partial<MetadataCandidate> = {}): MetadataCandidate {
	return {
		type: "movie",
		identity: { providerId: "tmdb", entityType: "movie", externalId: "42" },
		title: "Edited Title",
		releaseDate: "2026-02-02",
		artwork: [{ kind: "poster", url: "/new-poster.jpg" }],
		...overrides,
	};
}

describe("toMetadataCandidate", () => {
	test("maps provider artwork paths to typed artwork entries", () => {
		const mapped = toMetadataCandidate("movie", "tmdb", providerResult({ logoPath: "/logo.png" }));

		expect(mapped.type).toBe("movie");
		expect(mapped.identity).toEqual({ providerId: "tmdb", entityType: "movie", externalId: "42" });
		expect(mapped.artwork).toEqual([
			{ kind: "poster", url: "/poster.jpg" },
			{ kind: "backdrop", url: "/backdrop.jpg" },
			{ kind: "logo", url: "/logo.png" },
		]);
	});

	test("omits artwork kinds without a provider path", () => {
		const mapped = toMetadataCandidate("movie", "tmdb", providerResult({ posterPath: undefined, backdropPath: undefined }));
		expect(mapped.artwork).toEqual([]);
	});
});

describe("applyMetadataCandidate", () => {
	test("applies plugin edits; the candidate owns the full artwork set", () => {
		const original = providerResult({ popularity: 12.5 });
		const applied = applyMetadataCandidate(
			"movie",
			"tmdb",
			original,
			candidate({
				artwork: [
					{ kind: "poster", url: "/new-poster.jpg" },
					{ kind: "backdrop", url: "/new-backdrop.jpg" },
				],
			}),
		);

		expect(applied.title).toBe("Edited Title");
		expect(applied.releaseDate).toBe("2026-02-02");
		expect(applied.posterPath).toBe("/new-poster.jpg");
		expect(applied.backdropPath).toBe("/new-backdrop.jpg");
		expect(applied.popularity).toBe(12.5);
	});

	test("clears artwork kinds the candidate does not include", () => {
		const applied = applyMetadataCandidate("movie", "tmdb", providerResult(), candidate());
		expect(applied.backdropPath).toBeUndefined();
	});

	test("keeps the original releaseDate when the candidate drops it", () => {
		const applied = applyMetadataCandidate("movie", "tmdb", providerResult(), candidate({ releaseDate: undefined }));
		expect(applied.releaseDate).toBe("2026-01-01");
	});

	test("rejects candidates that change the metadata identity", () => {
		const changed = (identity: Partial<MetadataCandidate["identity"]>): MetadataCandidate =>
			candidate({ identity: { providerId: "tmdb", entityType: "movie", externalId: "42", ...identity } });

		expect(() => applyMetadataCandidate("movie", "tmdb", providerResult(), changed({ externalId: "43" }))).toThrow("identity");
		expect(() => applyMetadataCandidate("movie", "tmdb", providerResult(), changed({ providerId: "tvdb" }))).toThrow("identity");
		expect(() => applyMetadataCandidate("movie", "tmdb", providerResult(), candidate({ type: "tv_show" }))).toThrow("identity");
	});

	test("rejects candidates without a title or with empty artwork URLs", () => {
		expect(() => applyMetadataCandidate("movie", "tmdb", providerResult(), candidate({ title: "   " }))).toThrow("invalid");
		expect(() =>
			applyMetadataCandidate("movie", "tmdb", providerResult(), candidate({ artwork: [{ kind: "poster", url: "  " }] })),
		).toThrow("URL");
	});
});
