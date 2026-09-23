import type { MetadataProviderConfiguration } from "@reelvault/sdk/common";
import type { MetadataProvider } from "@reelvault/sdk/plugin";
import {
	type MetadataProviderSetting,
	metadataProviderSettingsRepository,
} from "@/database/repositories/metadata-provider-settings.repository";
import { pluginRegistry } from "@/plugins/lifecycle/plugin.registry";
import { serverConfig } from "@/server.config";
import { toMap } from "@/utils/array.utils";
import { BaseService } from "@/utils/base-service";
import { ValidationError } from "@/utils/errors";

class MetadataProviderSettingsService extends BaseService {
	private cachedSettings?: { expiresAt: number; values: Map<string, MetadataProviderSetting> } | undefined;
	private cachedOrdered?: { source: MetadataProvider[]; values: MetadataProvider[] } | undefined;

	constructor() {
		super("MetadataProviderSettingsService");
	}

	async getOrderedProviders(): Promise<MetadataProvider[]> {
		const source = pluginRegistry.getProviders();
		if (this.cachedOrdered?.source === source) return this.cachedOrdered.values;

		const settings = await this.getSettings();
		const values = source
			.filter((provider) => settings.get(provider.id)?.enabled ?? true)
			.toSorted((left, right) => {
				const priorityDifference =
					(settings.get(left.id)?.priority ?? serverConfig.plugins.providers.defaultPriority) -
					(settings.get(right.id)?.priority ?? serverConfig.plugins.providers.defaultPriority);

				return priorityDifference || left.id.localeCompare(right.id);
			});
		this.cachedOrdered = { source, values };

		return values;
	}

	async getPriority(providerId: string): Promise<number> {
		return (await this.getSettings()).get(providerId)?.priority ?? serverConfig.plugins.providers.defaultPriority;
	}

	async list(): Promise<MetadataProviderConfiguration[]> {
		const settings = await this.getSettings();
		const providers = pluginRegistry.getProviderStatus();

		return providers
			.map((provider) => ({
				...provider,
				priority: settings.get(provider.id)?.priority ?? serverConfig.plugins.providers.defaultPriority,
				enabled: settings.get(provider.id)?.enabled ?? true,
			}))
			.toSorted((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
	}

	async update(providerId: string, values: { priority?: number; enabled?: boolean }): Promise<MetadataProviderConfiguration> {
		const provider = pluginRegistry.getProviderStatus().find((item) => item.id === providerId);
		this.assertExists(provider, "Metadata provider", providerId);
		await metadataProviderSettingsRepository.upsert(providerId, values);
		this.invalidateCache();
		const updated = (await this.list()).find((item) => item.id === providerId);
		this.assertExists(updated, "Metadata provider", providerId);

		return updated;
	}

	async reorder(providerIds: readonly string[]): Promise<MetadataProviderConfiguration[]> {
		const registered = new Set(pluginRegistry.getProviderStatus().map((provider) => provider.id));
		const unknown = providerIds.filter((providerId) => !registered.has(providerId));
		if (unknown.length > 0) throw new ValidationError(`Unknown metadata providers: ${unknown.join(", ")}`);

		await metadataProviderSettingsRepository.reorder(providerIds);
		this.invalidateCache();

		return this.list();
	}

	invalidateCache(): void {
		this.cachedSettings = undefined;
		this.cachedOrdered = undefined;
	}

	private async getSettings(): Promise<Map<string, MetadataProviderSetting>> {
		if (this.cachedSettings && this.cachedSettings.expiresAt > Date.now()) return this.cachedSettings.values;

		let persistedSettings: MetadataProviderSetting[] = [];
		try {
			persistedSettings = await metadataProviderSettingsRepository.list();
		} catch (error) {
			const cause = error instanceof Error ? error.cause : undefined;
			const errorText = `${String(error)} ${String(cause)}`;
			if (!errorText.includes("no such table: metadata_provider_settings")) throw error;
		}

		const values = toMap(persistedSettings, (setting) => setting.providerId);
		this.cachedSettings = { expiresAt: Date.now() + serverConfig.plugins.providers.settingsCacheTtlMs, values };

		return values;
	}
}

export const metadataProviderSettingsService = new MetadataProviderSettingsService();
