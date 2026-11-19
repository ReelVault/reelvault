import { describe, expect, test } from "bun:test";
import { ProfileScopedCache } from "./cache-invalidation.cache";

describe("ProfileScopedCache", () => {
	test("clearing one profile drops its cached entries and leaves other profiles' entries cached", async () => {
		const cache = new ProfileScopedCache<string>({ ttlMs: 60_000, maxSize: 2, name: "profile-scoped-cache-test" });

		await cache.getOrSet("profile-1:a", async () => "a");
		await cache.getOrSet("profile-1:b", async () => "b");
		// Evicts profile-1:a, the least recently used entry.
		await cache.getOrSet("profile-2:c", async () => "c");

		cache.clearProfile("profile-1");

		expect(await cache.getOrSet("profile-1:b", async () => "b-reloaded")).toBe("b-reloaded");
		expect(await cache.getOrSet("profile-2:c", async () => "c-reloaded")).toBe("c");
	});
});
