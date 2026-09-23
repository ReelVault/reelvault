import { afterEach, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MetadataProvider, PluginManifest, PluginRuntime, ReelVaultPlugin } from "@sdk/plugin";

process.env.NODE_ENV ??= "test";
process.env.APP_PORT ??= "3030";
process.env.ROOT_DIR ??= join(tmpdir(), `reelvault-tests-${process.pid}`);

const { pluginEventBus } = await import("@/plugins/runtime/plugin.events");
const { providerService } = await import("@/plugins/capabilities/provider.service");
const { pluginRegistry } = await import("@/plugins/lifecycle/plugin.registry");

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
	afterEach(() => {
		pluginEventBus.offPlugin("event-observer");
		pluginRegistry.clear();
	});

	it("publishes each actual metadata search request", async () => {
		const received: Array<{ type: "movie" | "tv_show"; title: string; year?: number | undefined }> = [];
		pluginEventBus.on("event-observer", "metadata.search.requested", (payload) => {
			received.push(payload);
		});
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
