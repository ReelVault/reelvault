import { afterEach, describe, expect, test } from "bun:test";
import { ProfileInsightsSchema } from "@reelvault/sdk/common";
import { Value } from "@sinclair/typebox/value";
import { clearProfileInsights, profileInsightsCache } from "./cache-invalidation.cache";

afterEach(() => {
	profileInsightsCache.clear();
});

describe("clearProfileInsights", () => {
	test("drops the named profile's cached entry so the next read reloads it", async () => {
		const key = "profile-1:insights:7d";
		let loadCount = 0;
		const value = Value.Create(ProfileInsightsSchema);
		const loader = () => {
			loadCount++;

			return Promise.resolve({ ...value, totalMinutes: loadCount * 10 });
		};

		const first = await profileInsightsCache.getOrSet(key, loader);
		const cached = await profileInsightsCache.getOrSet(key, loader);
		expect(cached.totalMinutes).toBe(first.totalMinutes);

		clearProfileInsights("profile-1");

		const reloaded = await profileInsightsCache.getOrSet(key, loader);
		expect(reloaded.totalMinutes).toBe(20);
	});
});
