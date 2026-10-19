import type { LibraryProviderPriority, MetadataProviderConfiguration } from "@reelvault/sdk/common";
import type { MetadataProvider } from "@reelvault/sdk/plugin";
import { type MetadataProviderSetting, pluginProviderSettingsData } from "@/app/plugins/plugin-data.service";
import { serverConfig } from "@/config/server/server.config";
import { pluginRegistry } from "@/plugins/lifecycle/plugin.registry";
import { toMap } from "@/utils/array.utils";
import { assertFound, DomainError } from "@/utils/domain.errors";
import { createLogger } from "@/utils/logger.utils";
import { MemoryCache } from "@/utils/memory.cache";

/** Upper bound on cached per-library override sets (oldest entry is dropped first). */
const LIBRARY_OVERRIDES_CACHE_MAX_ENTRIES = 200;

class MetadataProviderSettingsService {
	readonly serviceName = "MetadataProviderSettingsService";
	readonly logger = createLogger("MetadataProviderSettingsService");

	private cachedOrdered?: { source: MetadataProvider[]; values: MetadataProvider[] } | undefined;
	private readonly cachedSettings = new MemoryCache<Map<string, MetadataProviderSetting>>({
		ttlMs: serverConfig.plugins.providers.settingsCacheTtlMs,
		maxSize: 1,
	});
	private readonly cachedLibraryOverrides = new MemoryCache<Map<string, LibraryProviderPriority>>({
		ttlMs: serverConfig.plugins.providers.settingsCacheTtlMs,
		maxSize: LIBRARY_OVERRIDES_CACHE_MAX_ENTRIES,
	});

	async getOrderedProviders(libraryId?: string): Promise<MetadataProvider[]> {
		const source = pluginRegistry.getProviders();
		if (!libraryId) {
			if (this.cachedOrdered?.source === source) return this.cachedOrdered.values;
		}

		const settings = await this.getSettings();
		const overrides = libraryId ? await this.getLibraryOverrides(libraryId) : undefined;
		const values = source
			.filter((provider) => overrides?.get(provider.id)?.enabled ?? settings.get(provider.id)?.enabled ?? true)
			.toSorted((left, right) => {
				const priorityDifference =
					(overrides?.get(left.id)?.priority ?? settings.get(left.id)?.priority ?? serverConfig.plugins.providers.defaultPriority) -
					(overrides?.get(right.id)?.priority ?? settings.get(right.id)?.priority ?? serverConfig.plugins.providers.defaultPriority);

				return priorityDifference || left.id.localeCompare(right.id);
			});

		if (libraryId) return values;

		this.cachedOrdered = { source, values };

		return values;
	}

	/** Saves the full override set for one library (empty list clears overrides). */
	async setLibraryOverrides(libraryId: string, priorities: LibraryProviderPriority[]): Promise<void> {
		await pluginProviderSettingsData.replaceLibraryPriorities(libraryId, priorities);
		this.cachedLibraryOverrides.delete(libraryId);
	}

	async getLibraryOverrides(libraryId: string): Promise<Map<string, LibraryProviderPriority>> {
		return await this.cachedLibraryOverrides.getOrSet(libraryId, async () => {
			const rows = await pluginProviderSettingsData.listLibraryPriorities(libraryId);

			return new Map<string, LibraryProviderPriority>(
				rows.map((row) => [row.providerId, { providerId: row.providerId, priority: row.priority, enabled: row.enabled }]),
			);
		});
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
		assertFound(provider, "Metadata provider", providerId);
		await pluginProviderSettingsData.upsertMetadataProviderSetting(providerId, values);
		this.invalidateCache();
		const updated = (await this.list()).find((item) => item.id === providerId);
		assertFound(updated, "Metadata provider", providerId);

		return updated;
	}

	async reorder(providerIds: readonly string[]): Promise<MetadataProviderConfiguration[]> {
		const registered = new Set(pluginRegistry.getProviderStatus().map((provider) => provider.id));
		const unknown = providerIds.filter((providerId) => !registered.has(providerId));
		if (unknown.length > 0)
			throw new DomainError("validation", `Unknown metadata providers: ${unknown.join(", ")}`, {
				code: "metadata.providers_unknown",
				params: { providers: unknown.join(", ") },
			});

		await pluginProviderSettingsData.reorderMetadataProviders(providerIds);
		this.invalidateCache();

		return this.list();
	}

	invalidateCache(): void {
		this.cachedOrdered = undefined;
		this.cachedSettings.clear();
		this.cachedLibraryOverrides.clear();
	}

	private async getSettings(): Promise<Map<string, MetadataProviderSetting>> {
		return await this.cachedSettings.getOrSet("settings", async () => {
			const persistedSettings = await pluginProviderSettingsData.listMetadataProviderSettings();

			return toMap(persistedSettings, (setting) => setting.providerId);
		});
	}
}

export const metadataProviderSettingsService = new MetadataProviderSettingsService();
