import { describe, expect, test } from "bun:test";
import { createLocalMetadataStableKey, createLocalStableKey, createProviderPersonId, createProviderStableKey } from "./stable-key.utils";

describe("stable keys", () => {
	// The keys are persisted, so the exact format is pinned: "v1:provider:<entityType>:<hex provider>:<hex external id>".
	test("normalizes the provider name before deriving the key", () => {
		expect(createProviderStableKey({ providerName: " TMDB ", entityType: "movie", externalId: "123" })).toBe(
			"v1:provider:movie:746d6462:313233",
		);
		expect(createProviderStableKey({ providerName: "tmdb", entityType: "movie", externalId: "123" })).toBe(
			"v1:provider:movie:746d6462:313233",
		);
	});

	test("keeps different entity types and IDs separate", () => {
		expect(createProviderStableKey({ providerName: "tmdb", entityType: "movie", externalId: "1" })).toBe("v1:provider:movie:746d6462:31");
		expect(createProviderStableKey({ providerName: "tmdb", entityType: "tv_show", externalId: "1" })).toBe(
			"v1:provider:tv_show:746d6462:31",
		);
		// A colon in the external id cannot forge another field: it is hex-encoded like every other component.
		expect(createProviderStableKey({ providerName: "tmdb", entityType: "movie", externalId: "a:b" })).toBe(
			"v1:provider:movie:746d6462:613a62",
		);
		expect(createProviderStableKey({ providerName: "tmdb", entityType: "movie", externalId: "a" })).toBe("v1:provider:movie:746d6462:61");
	});

	test("supports a versioned local fallback namespace", () => {
		expect(createLocalStableKey({ namespace: "library-path", value: "/Movies" })).toBe("v1:local:6c6962726172792d70617468:2f6d6f76696573");
	});

	test("builds a stable metadata fallback from normalized identity fields", () => {
		expect(createLocalMetadataStableKey({ title: " Dune ", type: "movie", releaseDate: "2021-01-01" })).toBe(
			"v1:local:6d65746164617461:64756e657c6d6f7669657c323032312d30312d3031",
		);
		expect(createLocalMetadataStableKey({ title: "dune", type: "movie", releaseDate: "2021-01-01" })).toBe(
			"v1:local:6d65746164617461:64756e657c6d6f7669657c323032312d30312d3031",
		);
	});

	// Person ids are persisted, so these vectors pin the derivation to the RFC 4122 v5 values (independently computed).
	test("derives provider person ids as pinned RFC 4122 name-based UUIDs", () => {
		expect(createProviderPersonId("tmdb", "603")).toBe("64ce9f4b-9083-581e-babc-445f5dcf2e78");
		expect(createProviderPersonId("tmdb", "1")).toBe("ad684b21-34b4-5c69-9dcb-0b43122ed36d");
		expect(createProviderPersonId("imdb", "nm0000001")).toBe("0bb376a9-beda-57fb-82b8-ca3b9d8ddcf6");
		expect(createProviderPersonId("p", "with:colons")).toBe("49776380-05b2-5e41-95c9-94a45e96b88a");
	});

	test("trims provider name and external id before deriving the person id", () => {
		expect(createProviderPersonId(" tmdb ", "  603 ")).toBe("64ce9f4b-9083-581e-babc-445f5dcf2e78");
	});

	test("keeps non-ASCII provider identity in the derivation", () => {
		expect(createProviderPersonId("Zoë", "Ünïcode-日本語-🎬")).toBe("371ac189-c245-507b-ad01-5f7619cff146");
	});
});
