import { describe, expect, test } from "bun:test";
import { createImageStableKey, createImageStoragePath } from "./image-storage.utils";

const posterPathPattern = /^\/data\/images\/posters\/[a-f0-9]{64}\.webp$/;
const backdropPathPattern = /^\/data\/images\/backdrops\/[a-f0-9]{64}\.webp$/;
const peoplePathPattern = /^\/data\/images\/people\/[a-f0-9]{64}\.webp$/;

describe("image storage keys and paths", () => {
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
