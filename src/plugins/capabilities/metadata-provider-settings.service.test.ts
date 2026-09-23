import { afterEach, expect, test } from "bun:test";
import type { MetadataProvider, PluginManifest, PluginRuntime, ReelVaultPlugin } from "@sdk/plugin";
import { metadataProviderSettingsRepository } from "@/database/repositories/metadata-provider-settings.repository";
import { pluginRegistry } from "@/plugins/lifecycle/plugin.registry";
import { metadataProviderSettingsService } from "./metadata-provider-settings.service";

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

const originalList = metadataProviderSettingsRepository.list;
const originalUpsert = metadataProviderSettingsRepository.upsert;
const originalReorder = metadataProviderSettingsRepository.reorder;

afterEach(() => {
	metadataProviderSettingsRepository.list = originalList;
	metadataProviderSettingsRepository.upsert = originalUpsert;
	metadataProviderSettingsRepository.reorder = originalReorder;
	metadataProviderSettingsService.invalidateCache();
	pluginRegistry.clear();
});

test("orders enabled providers by priority and stable provider id", async () => {
	registerProviders([createProvider("z-provider"), createProvider("a-provider"), createProvider("disabled-provider")]);
	metadataProviderSettingsRepository.list = async () => [
		{ providerId: "z-provider", priority: 20, enabled: true, createdAt: new Date(), updatedAt: new Date() },
		{ providerId: "a-provider", priority: 20, enabled: true, createdAt: new Date(), updatedAt: new Date() },
		{ providerId: "disabled-provider", priority: 1, enabled: false, createdAt: new Date(), updatedAt: new Date() },
	];
	metadataProviderSettingsService.invalidateCache();

	expect((await metadataProviderSettingsService.getOrderedProviders()).map((provider) => provider.id)).toEqual([
		"a-provider",
		"z-provider",
	]);
});

test("invalidates the provider order cache after an update", async () => {
	registerProviders([createProvider("provider-a"), createProvider("provider-b")]);
	const settings = [
		{ providerId: "provider-a", priority: 10, enabled: true, createdAt: new Date(), updatedAt: new Date() },
		{ providerId: "provider-b", priority: 20, enabled: true, createdAt: new Date(), updatedAt: new Date() },
	];
	metadataProviderSettingsRepository.list = async () => settings;
	metadataProviderSettingsRepository.upsert = (providerId, values) => {
		const current = settings.find((setting) => setting.providerId === providerId);
		if (!current) throw new Error("missing setting");

		Object.assign(current, values);

		return Promise.resolve(current);
	};
	metadataProviderSettingsService.invalidateCache();

	expect((await metadataProviderSettingsService.getOrderedProviders()).map((provider) => provider.id)).toEqual([
		"provider-a",
		"provider-b",
	]);
	await metadataProviderSettingsService.update("provider-b", { priority: 0 });
	expect((await metadataProviderSettingsService.getOrderedProviders()).map((provider) => provider.id)).toEqual([
		"provider-b",
		"provider-a",
	]);
});

test("reorder persists sequential priorities and returns the refreshed order", async () => {
	registerProviders([createProvider("provider-a"), createProvider("provider-b")]);
	const settings = [
		{ providerId: "provider-a", priority: 10, enabled: true, createdAt: new Date(), updatedAt: new Date() },
		{ providerId: "provider-b", priority: 20, enabled: true, createdAt: new Date(), updatedAt: new Date() },
	];
	metadataProviderSettingsRepository.list = async () => settings;
	metadataProviderSettingsRepository.reorder = async (providerIds) => {
		await Promise.resolve(
			providerIds.forEach((providerId, index) => {
				const current = settings.find((setting) => setting.providerId === providerId);
				if (current) current.priority = (index + 1) * 10;
			}),
		);
	};
	metadataProviderSettingsService.invalidateCache();

	const result = await metadataProviderSettingsService.reorder(["provider-b", "provider-a"]);

	expect(result.map((provider) => provider.id)).toEqual(["provider-b", "provider-a"]);
	expect((await metadataProviderSettingsService.getOrderedProviders()).map((provider) => provider.id)).toEqual([
		"provider-b",
		"provider-a",
	]);
});

test("rejects reordering unknown providers", async () => {
	registerProviders([createProvider("provider-a")]);

	await expect(metadataProviderSettingsService.reorder(["provider-a", "ghost-provider"])).rejects.toThrow("Unknown metadata providers");
});
