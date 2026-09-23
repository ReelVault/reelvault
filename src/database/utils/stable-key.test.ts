import { describe, expect, test } from "bun:test";
import { createImageStableKey, createImageStoragePath } from "@/utils/image-storage.utils";
import { createLocalMetadataStableKey, createLocalStableKey, createProviderStableKey } from "./stable-key";

const posterPathPattern = /^\/data\/images\/posters\/[a-f0-9]{64}\.webp$/;
const backdropPathPattern = /^\/data\/images\/backdrops\/[a-f0-9]{64}\.webp$/;
const peoplePathPattern = /^\/data\/images\/people\/[a-f0-9]{64}\.webp$/;

describe("stable keys", () => {
	test("normalizes provider identity and prevents delimiter collisions", () => {
		const first = createProviderStableKey({ providerName: " TMDB ", entityType: "movie", externalId: "123" });
		const second = createProviderStableKey({ providerName: "tmdb", entityType: "movie", externalId: "123" });

		expect(first).toBe(second);
		expect(first).toBe("v1:provider:movie:746d6462:313233");
	});

	test("keeps different entity types and IDs separate", () => {
		expect(createProviderStableKey({ providerName: "tmdb", entityType: "movie", externalId: "1" })).not.toBe(
			createProviderStableKey({ providerName: "tmdb", entityType: "tv_show", externalId: "1" }),
		);
		expect(createProviderStableKey({ providerName: "tmdb", entityType: "movie", externalId: "a:b" })).not.toBe(
			createProviderStableKey({ providerName: "tmdb", entityType: "movie", externalId: "a" }),
		);
	});

	test("keeps provider identity stable when the display title changes", () => {
		const beforeRename = createProviderStableKey({ providerName: "tmdb", entityType: "movie", externalId: "123" });
		const afterRename = createProviderStableKey({ providerName: "tmdb", entityType: "movie", externalId: "123" });

		expect(afterRename).toBe(beforeRename);
	});

	test("supports a versioned local fallback namespace", () => {
		expect(createLocalStableKey({ namespace: "library-path", value: "/Movies" })).toBe("v1:local:6c6962726172792d70617468:2f6d6f76696573");
	});

	test("builds a stable metadata fallback from normalized identity fields", () => {
		expect(createLocalMetadataStableKey({ title: " Dune ", type: "movie", releaseDate: "2021-01-01" })).toBe(
			createLocalMetadataStableKey({ title: "dune", type: "movie", releaseDate: "2021-01-01" }),
		);
	});

	test("builds an image key from owner, type and content hash", () => {
		expect(createImageStableKey({ ownerStableKey: "owner", imageType: "poster", sourceHash: "abc" })).toBe(
			"v1:local:696d616765:6f776e65723a706f737465723a616263",
		);
	});

	test("builds the categorized image path based on image type", () => {
		const poster = createImageStoragePath({ root: "/data/images", stableKey: "v1:local:metadata:abc", imageType: "poster" });
		const backdrop = createImageStoragePath({ root: "/data/images", stableKey: "v1:local:metadata:abc", imageType: "backdrop" });
		const person = createImageStoragePath({ root: "/data/images", stableKey: "v1:local:metadata:abc", imageType: "profile" });

		expect(poster).toMatch(posterPathPattern);
		expect(backdrop).toMatch(backdropPathPattern);
		expect(person).toMatch(peoplePathPattern);
	});
});
