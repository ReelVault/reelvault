import { afterEach, beforeEach, expect, test } from "bun:test";
import type { MetadataProvider, PluginManifest, PluginRuntime, ReelVaultPlugin } from "@reelvault/sdk/plugin";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { pluginRegistry } from "@/plugins/lifecycle/plugin.registry";
import { libraryProviderSettingsRepository } from "@/repositories/library-provider-settings.repository";
import { metadataProviderSettingsRepository } from "@/repositories/metadata-provider-settings.repository";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { metadataProviderSettingsService } from "./metadata-provider-settings.service";

const db = useTestDatabase();
const plugin: ReelVaultPlugin = { setup: async () => undefined };
const manifest: PluginManifest = {
	id: "provider-priority-test-plugin",
	name: "Provider priority test plugin",
	version: "1.0.0",
	entry: "./dist/index.js",
	capabilities: ["metadataProvider"],
};

function createProvider(id: string): MetadataProvider {
	return {
		id,
		name: id,
		version: "1.0.0",
		initialize: async () => undefined,
		search: async () => [],
		getDetails: async () => null,
		getSeasonDetails: async () => null,
		getEpisodeDetails: async () => null,
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
}

async function orderedIds(): Promise<string[]> {
	return (await metadataProviderSettingsService.getOrderedProviders()).map((provider) => provider.id);
}

// The order cache and the plugin registry are process-wide: a provider or a cached order from another file must not leak in.
function resetProviderState(): void {
	metadataProviderSettingsService.invalidateCache();
	pluginRegistry.clear();
}

beforeEach(resetProviderState);
afterEach(resetProviderState);

test("the per-library override cache is bounded: a cached override is served until 200 other libraries push it out", async () => {
	const [library] = await db
		.client()
		.insert(schema.libraries)
		.values({ name: "Cap library", type: "movies" })
		.returning({ id: schema.libraries.id });
	if (!library) throw new Error("The library should be inserted");
	await libraryProviderSettingsRepository.replaceForLibrary(library.id, [{ providerId: "provider-a", priority: 1, enabled: true }]);
	expect((await metadataProviderSettingsService.getLibraryOverrides(library.id)).get("provider-a")?.priority).toBe(1);

	// Written straight to the table, so the service keeps serving its cached copy.
	await libraryProviderSettingsRepository.replaceForLibrary(library.id, [{ providerId: "provider-a", priority: 9, enabled: true }]);
	expect((await metadataProviderSettingsService.getLibraryOverrides(library.id)).get("provider-a")?.priority).toBe(1);

	for (let index = 0; index < 200; index += 1) await metadataProviderSettingsService.getLibraryOverrides(`cap-library-${index}`);

	expect((await metadataProviderSettingsService.getLibraryOverrides(library.id)).get("provider-a")?.priority).toBe(9);
});

test("orders enabled providers by priority, equal priorities by provider id, and leaves out disabled ones", async () => {
	registerProviders([createProvider("z-provider"), createProvider("a-provider"), createProvider("disabled-provider")]);
	await metadataProviderSettingsRepository.upsert("z-provider", { priority: 20, enabled: true });
	await metadataProviderSettingsRepository.upsert("a-provider", { priority: 20, enabled: true });
	await metadataProviderSettingsRepository.upsert("disabled-provider", { priority: 1, enabled: false });

	expect(await orderedIds()).toEqual(["a-provider", "z-provider"]);
});

test("invalidates the provider order cache after an update", async () => {
	registerProviders([createProvider("provider-a"), createProvider("provider-b")]);
	await metadataProviderSettingsRepository.upsert("provider-a", { priority: 10, enabled: true });
	await metadataProviderSettingsRepository.upsert("provider-b", { priority: 20, enabled: true });
	expect(await orderedIds()).toEqual(["provider-a", "provider-b"]);

	await metadataProviderSettingsService.update("provider-b", { priority: 0 });

	expect(await orderedIds()).toEqual(["provider-b", "provider-a"]);
});

test("reorder persists the new order and returns the refreshed order", async () => {
	registerProviders([createProvider("provider-a"), createProvider("provider-b")]);
	await metadataProviderSettingsRepository.upsert("provider-a", { priority: 10, enabled: true });
	await metadataProviderSettingsRepository.upsert("provider-b", { priority: 20, enabled: true });

	const result = await metadataProviderSettingsService.reorder(["provider-b", "provider-a"]);

	expect(result.map((provider) => provider.id)).toEqual(["provider-b", "provider-a"]);
	expect((await metadataProviderSettingsRepository.list()).map((setting) => setting.providerId)).toEqual(["provider-b", "provider-a"]);
	expect(await orderedIds()).toEqual(["provider-b", "provider-a"]);
});

test("rejects reordering unknown providers", async () => {
	registerProviders([createProvider("provider-a")]);

	await expect(metadataProviderSettingsService.reorder(["provider-a", "ghost-provider"])).rejects.toMatchObject({
		category: "validation",
		code: "metadata.providers_unknown",
	});
});
