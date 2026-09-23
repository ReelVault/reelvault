import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { MetadataProvider } from "@sdk/plugin";
import { ProviderLookupCache } from "./provider-lookup.cache";

function createProvider(id: string): MetadataProvider {
	return {
		id,
		name: id.toUpperCase(),
		version: "1.0.0",
		initialize: async () => undefined,
		search: async () => [],
		getDetails: async () => null,
		getSeasonDetails: async () => null,
		getEpisodeDetails: async () => null,
	};
}

describe("ProviderLookupCache", () => {
	let cache: ProviderLookupCache;

	beforeEach(() => {
		cache = new ProviderLookupCache();
	});

	afterEach(() => cache.clear());

	test("registers providers per plugin and resolves lookups by id", () => {
		const tmdb = createProvider("tmdb");
		cache.register("plugin-a", [tmdb]);

		expect(cache.get("tmdb")).toBe(tmdb);
		expect(cache.getStatuses()).toEqual([{ id: "tmdb", name: "TMDB", version: "1.0.0", pluginId: "plugin-a" }]);
	});

	test("assertRegisterable rejects a provider id owned by another plugin", () => {
		cache.register("plugin-a", [createProvider("tmdb")]);

		expect(() => cache.assertRegisterable([createProvider("tmdb")])).toThrow('Provider "tmdb" is already registered by plugin "plugin-a"');
		expect(() => cache.assertRegisterable([createProvider("fresh")])).not.toThrow();
	});

	test("getAll returns a stable sorted list invalidated on mutation", () => {
		cache.register("plugin-a", [createProvider("zeta")]);
		expect(cache.getAll().map((provider) => provider.id)).toEqual(["zeta"]);

		cache.register("plugin-b", [createProvider("alpha")]);
		expect(cache.getAll().map((provider) => provider.id)).toEqual(["alpha", "zeta"]);
		expect(cache.getStatuses().map((status) => status.pluginId)).toEqual(["plugin-b", "plugin-a"]);
	});

	test("removeForPlugin drops only that plugin's providers and frees their ids", () => {
		cache.register("plugin-a", [createProvider("shared"), createProvider("a-only")]);
		cache.register("plugin-b", [createProvider("b-only")]);

		cache.removeForPlugin("plugin-a");

		expect(cache.get("shared")).toBeUndefined();
		expect(cache.get("a-only")).toBeUndefined();
		expect(cache.get("b-only")).toBeDefined();
		expect(() => cache.assertRegisterable([createProvider("shared")])).not.toThrow();
	});

	test("clear empties the table", () => {
		cache.register("plugin-a", [createProvider("tmdb")]);
		cache.clear();

		expect(cache.get("tmdb")).toBeUndefined();
		expect(cache.getAll()).toEqual([]);
		expect(cache.getStatuses()).toEqual([]);
	});
});
