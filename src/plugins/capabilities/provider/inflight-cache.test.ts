import { describe, expect, test } from "bun:test";
import { ProviderResultCaches, providerCaches, resetProviderCaches } from "./inflight.cache";

describe("ProviderResultCaches", () => {
	test("keeps each provider-scoped cache independent of the others", () => {
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

	test("holds more than one result in a provider cache", () => {
		resetProviderCaches();
		const caches = providerCaches();

		caches.details.set("first", []);
		caches.details.set("second", []);

		expect(caches.details.get("first")).toEqual([]);
		expect(caches.details.get("second")).toEqual([]);
	});
});
