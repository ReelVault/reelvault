import { afterEach, beforeEach, expect, test } from "bun:test";
import type { MetadataProvider, PluginManifest, PluginRuntime, ReelVaultPlugin } from "@reelvault/sdk/plugin";
import { metadataProviderSettingsRepository } from "@/database/repositories/metadata-provider-settings.repository";
import { pluginRegistry } from "@/plugins/lifecycle/plugin.registry";
import { metadataProviderSettingsService } from "./metadata-provider-settings.service";
import { providerService } from "./provider.service";

const plugin: ReelVaultPlugin = { setup: async () => undefined };
const manifest: PluginManifest = {
	id: "provider-link-test-plugin",
	name: "Provider link test plugin",
	version: "1.0.0",
	entry: "./dist/index.js",
	capabilities: ["metadataProvider"],
};

function createProvider(id: string, overrides: Partial<MetadataProvider> = {}): MetadataProvider {
	return {
		id,
		name: id,
		version: "1.0.0",
		initialize: async () => undefined,
		search: async () => [],
		getDetails: async () => null,
		getSeasonDetails: async () => null,
		getEpisodeDetails: async () => null,
		...overrides,
	};
}

function registerProviders(providers: MetadataProvider[]): void {
	const runtime: PluginRuntime = {
		manifest,
		plugin,
		state: "discovered",
		providerIds: providers.map((provider) => provider.id),
		subtitleProviderIds: [],
		analyzerIds: [],
		jobNames: [],
	};
	pluginRegistry.register(runtime, providers);
	pluginRegistry.enable(manifest.id);
	metadataProviderSettingsService.invalidateCache();
}

const originalList = metadataProviderSettingsRepository.list;

beforeEach(() => {
	// Settings lookups would otherwise hit the un-migrated test DB; these tests
	// only need "no persisted overrides".
	metadataProviderSettingsRepository.list = () => Promise.resolve([]);
});

afterEach(() => {
	metadataProviderSettingsRepository.list = originalList;
	pluginRegistry.clear();
	metadataProviderSettingsService.invalidateCache();
});

test("queries each linked provider with its own external id, ordered by priority", async () => {
	const calls: Array<{ providerId: string; externalId: string; season: number }> = [];
	registerProviders([
		createProvider("a-provider", {
			getSeasonDetails: (externalId, seasonNumber) => {
				calls.push({ providerId: "a-provider", externalId, season: seasonNumber });

				return Promise.resolve({ externalId, seasonNumber, name: `A season ${seasonNumber}` });
			},
		}),
		createProvider("b-provider", {
			getSeasonDetails: (externalId, seasonNumber) => {
				calls.push({ providerId: "b-provider", externalId, season: seasonNumber });

				return Promise.resolve({ externalId, seasonNumber, name: `B season ${seasonNumber}` });
			},
		}),
	]);

	const results = await providerService.fetchSeasonFromLinks(
		[
			{ providerId: "b-provider", externalId: "b-ext" },
			{ providerId: "a-provider", externalId: "a-ext" },
		],
		2,
	);

	expect(calls).toEqual([
		{ providerId: "a-provider", externalId: "a-ext", season: 2 },
		{ providerId: "b-provider", externalId: "b-ext", season: 2 },
	]);
	expect(results.map((result) => result.provider)).toEqual(["a-provider", "b-provider"]);
});

test("fetches episodes from each linked provider with its own external id", async () => {
	const calls: Array<{ providerId: string; externalId: string; season: number; episode: number }> = [];
	registerProviders([
		createProvider("a-provider", {
			getEpisodeDetails: (externalId, seasonNumber, episodeNumber) => {
				calls.push({ providerId: "a-provider", externalId, season: seasonNumber, episode: episodeNumber });

				return Promise.resolve({ externalId, seasonNumber, episodeNumber, name: `A episode ${episodeNumber}` });
			},
		}),
		createProvider("b-provider", {
			getEpisodeDetails: async () => null,
		}),
	]);

	const results = await providerService.fetchEpisodeFromLinks(
		[
			{ providerId: "b-provider", externalId: "b-ext" },
			{ providerId: "a-provider", externalId: "a-ext" },
		],
		3,
		4,
	);

	expect(calls).toEqual([{ providerId: "a-provider", externalId: "a-ext", season: 3, episode: 4 }]);
	expect(results).toHaveLength(1);
	expect(results[0]?.provider).toBe("a-provider");
});

test("fetchSeasonByProvider resolves one provider directly and caches the result", async () => {
	const calls: string[] = [];
	registerProviders([
		createProvider("a-provider", {
			getSeasonDetails: (externalId, seasonNumber) => {
				calls.push(`${externalId}:${seasonNumber}`);

				return Promise.resolve({ externalId, seasonNumber, name: `A season ${seasonNumber}` });
			},
		}),
	]);

	const first = await providerService.fetchSeasonByProvider("a-provider", "a-ext", 1);
	const cached = await providerService.fetchSeasonByProvider("a-provider", "a-ext", 1);
	const missing = await providerService.fetchSeasonByProvider("unknown-provider", "a-ext", 1);

	expect(first?.name).toBe("A season 1");
	expect(cached?.name).toBe("A season 1");
	expect(calls).toEqual(["a-ext:1"]);
	expect(missing).toBeNull();
});

test("fetchSeasonByProvider caches misses without re-hitting the provider", async () => {
	const calls: string[] = [];
	registerProviders([
		createProvider("a-provider", {
			getSeasonDetails: (externalId, seasonNumber) => {
				calls.push(`${externalId}:${seasonNumber}`);

				return Promise.resolve(null);
			},
		}),
	]);

	const first = await providerService.fetchSeasonByProvider("a-provider", "a-ext", 7);
	const cached = await providerService.fetchSeasonByProvider("a-provider", "a-ext", 7);

	expect(first).toBeNull();
	expect(cached).toBeNull();
	expect(calls).toEqual(["a-ext:7"]);
});

test("discover returns the first provider with items and caches only positive results", async () => {
	const calls: string[] = [];
	registerProviders([
		createProvider("a-provider", {
			discover: () => {
				calls.push("a");

				return Promise.resolve({ items: [], page: 1, totalPages: 0, totalResults: 0 });
			},
		}),
		createProvider("b-provider", {
			discover: () => {
				calls.push("b");

				return Promise.resolve({
					items: [{ externalId: "b-1", title: "B title", releaseDate: "2024-01-01" }],
					page: 1,
					totalPages: 1,
					totalResults: 1,
				});
			},
		}),
	]);

	const first = await providerService.discover({ type: "movie", category: "trending" });
	expect(first).toMatchObject({ providerId: "b-provider", items: [{ externalId: "b-1" }] });

	// Positive result cached — no provider is asked again.
	await expect(providerService.discover({ type: "movie", category: "trending" })).resolves.toEqual(first);
	expect(calls).toEqual(["a", "b"]);

	// providerId narrows the walk; the miss is not cached.
	await expect(providerService.discover({ type: "movie", category: "trending", providerId: "a-provider" })).resolves.toBeNull();
	expect(calls).toEqual(["a", "b", "a"]);
});

test("discover logs a failed provider and falls through to the next one", async () => {
	const calls: string[] = [];
	registerProviders([
		createProvider("a-provider", {
			discover: () => {
				calls.push("a");

				return Promise.reject(new Error("provider down"));
			},
		}),
		createProvider("b-provider", {
			discover: () => {
				calls.push("b");

				return Promise.resolve({
					items: [{ externalId: "b-1", title: "B title", releaseDate: "2024-01-01" }],
					page: 1,
					totalPages: 1,
					totalResults: 1,
				});
			},
		}),
	]);

	await expect(providerService.discover({ type: "movie", category: "popular" })).resolves.toMatchObject({ providerId: "b-provider" });
	expect(calls).toEqual(["a", "b"]);
});

test("getGenres skips providers without the capability and caches the first non-empty catalogue", async () => {
	const calls: string[] = [];
	registerProviders([
		createProvider("a-provider"),
		createProvider("b-provider", {
			getGenres: () => {
				calls.push("b");

				return Promise.resolve([]);
			},
		}),
		createProvider("c-provider", {
			getGenres: () => {
				calls.push("c");

				return Promise.resolve([{ id: "28", name: "Action" }]);
			},
		}),
	]);

	const genres = await providerService.getGenres("movie");
	expect(genres).toEqual([{ id: "28", name: "Action" }]);

	// The empty catalogue was not cached; the positive one was.
	await expect(providerService.getGenres("movie")).resolves.toEqual(genres);
	expect(calls).toEqual(["b", "c"]);

	// providerId narrows to the empty provider; that miss is retried, not cached.
	await expect(providerService.getGenres("movie", "b-provider")).resolves.toEqual([]);
	await expect(providerService.getGenres("movie", "b-provider")).resolves.toEqual([]);
	expect(calls).toEqual(["b", "c", "b", "b"]);
});
