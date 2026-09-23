import { afterEach, expect, test } from "bun:test";
import type { MetadataProvider, PluginManifest, PluginRuntime, ReelVaultPlugin } from "@sdk/plugin";
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

afterEach(() => {
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
