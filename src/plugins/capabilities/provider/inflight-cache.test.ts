import { describe, expect, test } from "bun:test";
import { ProviderResultCaches } from "./inflight-cache";

describe("ProviderResultCaches", () => {
	test("exposes seven independent provider-scoped caches", () => {
		const caches = new ProviderResultCaches();

		caches.details.set("a", []);
		caches.genres.set("g", []);
		expect(caches.details.get("a")).toEqual([]);
		expect(caches.genres.get("g")).toEqual([]);
		expect(caches.season.get("a")).toBeNull();
		expect(caches.aggregatedDetails.get("a")).toBeNull();
		expect(caches.episode.get("a")).toBeNull();
		expect(caches.person.get("a")).toBeNull();
		expect(caches.discovery.get("a")).toBeNull();
	});
});
