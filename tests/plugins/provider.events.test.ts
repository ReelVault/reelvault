import { afterEach, describe, expect, it } from "bun:test";
import type { MetadataProvider, PluginManifest, PluginRuntime, ReelVaultPlugin } from "@reelvault/sdk/plugin";
import { useTestDatabase } from "../helpers/test-database.helper";

const { pluginEventBus } = await import("@/system/extensions/plugin.events");
const { providerService } = await import("@/plugins/capabilities/provider.service");
const { pluginRegistry } = await import("@/plugins/lifecycle/plugin.registry");

// Provider settings are read from the migrated database; a fresh one has no rows, so every registered provider is enabled.
useTestDatabase();

const plugin: ReelVaultPlugin = { setup: async () => undefined };

function createProvider(overrides: Partial<MetadataProvider> = {}): MetadataProvider {
	return {
		id: "test-provider",
		name: "Test provider",
		version: "1.0.0",
		initialize: async () => undefined,
		search: async () => [{ externalId: "external-1", title: "The Example", releaseDate: "2024-01-01" }],
		getDetails: async () => ({ externalId: "external-1", title: "The Example", releaseDate: "2024-01-01" }),
		getSeasonDetails: async () => null,
		getEpisodeDetails: async () => null,
		...overrides,
	};
}

function registerProvider(provider = createProvider()): void {
	const manifest: PluginManifest = {
		id: "test-provider-plugin",
		name: "Test provider plugin",
		version: "1.0.0",
		entry: "./dist/index.js",
		capabilities: ["metadataProvider"],
	};
	const runtime: PluginRuntime = {
		manifest,
		plugin,
		state: "discovered",
		providerIds: ["test-provider"],
		subtitleProviderIds: [],
		analyzerIds: [],
		jobNames: [],
	};
	pluginRegistry.register(runtime, [provider]);
	pluginRegistry.enable(manifest.id);
}

describe("provider events", () => {
	const unsubscribers: Array<() => void> = [];

	afterEach(() => {
		for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
		pluginRegistry.clear();
	});

	it("publishes each actual metadata search request", async () => {
		const received: Array<{ type: "movie" | "tv_show"; title: string; year?: number | undefined }> = [];
		unsubscribers.push(
			pluginEventBus.on("event-observer", "metadata.search.requested", (payload) => {
				received.push(payload);
			}),
		);
		registerProvider();

		await providerService.search({ type: "movie", title: "The Example", year: 2024 });
		await Promise.all([
			providerService.fetchDetails("movie", { type: "movie", title: "The Example", year: 2024 }),
			providerService.fetchDetails("movie", { type: "movie", title: "The Example", year: 2024 }),
		]);

		expect(received).toEqual([
			expect.objectContaining({ type: "movie", title: "The Example", year: 2024, payloadVersion: 1 }),
			expect.objectContaining({ type: "movie", title: "The Example", year: 2024, payloadVersion: 1 }),
		]);
	});

	it("fetches a linked provider entity directly instead of searching by title again", async () => {
		const detailsCalls: Array<{ type: string; externalId: string }> = [];
		registerProvider(
			createProvider({
				search: () => {
					throw new Error("refresh must not search by title");
				},
				getDetails: (type, externalId) => {
					detailsCalls.push({ type, externalId });

					return Promise.resolve({ externalId, title: " Direct result ", releaseDate: "2024-01-01" });
				},
			}),
		);

		await expect(providerService.fetchDetailsByProvider("test-provider", "movie", "external-42")).resolves.toEqual({
			externalId: "external-42",
			title: "Direct result",
			releaseDate: "2024-01-01",
			cast: [],
		});
		expect(detailsCalls).toEqual([{ type: "movie", externalId: "external-42" }]);
	});
});
