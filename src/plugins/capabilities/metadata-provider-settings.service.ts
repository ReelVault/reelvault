import type { LibraryProviderPriority, MetadataProviderConfiguration } from "@reelvault/sdk/common";
import type { MetadataProvider } from "@reelvault/sdk/plugin";
import { libraryProviderSettingsRepository } from "@/database/repositories/library-provider-settings.repository";
import {
	type MetadataProviderSetting,
	metadataProviderSettingsRepository,
} from "@/database/repositories/metadata-provider-settings.repository";
import { pluginRegistry } from "@/plugins/lifecycle/plugin.registry";
import { serverConfig } from "@/server.config";
import { toMap } from "@/utils/array.utils";
import { assertFound, DomainError } from "@/utils/errors";
import { createLogger } from "@/utils/logger";

/** Upper bound on cached per-library override sets (oldest entry is dropped first). */
const LIBRARY_OVERRIDES_CACHE_MAX_ENTRIES = 200;

class MetadataProviderSettingsService {
	readonly serviceName = "MetadataProviderSettingsService";
	readonly logger = createLogger("MetadataProviderSettingsService");

	private cachedSettings?: { expiresAt: number; values: Map<string, MetadataProviderSetting> } | undefined;
	private cachedOrdered?: { source: MetadataProvider[]; values: MetadataProvider[] } | undefined;
	private readonly cachedLibraryOverrides = new Map<string, { expiresAt: number; values: Map<string, LibraryProviderPriority> }>();

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
		await libraryProviderSettingsRepository.replaceForLibrary(libraryId, priorities);
		this.cachedLibraryOverrides.delete(libraryId);
	}

	async getLibraryOverrides(libraryId: string): Promise<Map<string, LibraryProviderPriority>> {
		const cached = this.cachedLibraryOverrides.get(libraryId);
		if (cached && cached.expiresAt > Date.now()) return cached.values;

		const rows = await libraryProviderSettingsRepository.listForLibrary(libraryId);
		const values = new Map<string, LibraryProviderPriority>(
			rows.map((row) => [row.providerId, { providerId: row.providerId, priority: row.priority, enabled: row.enabled }]),
		);
		if (this.cachedLibraryOverrides.size >= LIBRARY_OVERRIDES_CACHE_MAX_ENTRIES) {
			const oldest = this.cachedLibraryOverrides.keys().next().value;
			if (oldest !== undefined) this.cachedLibraryOverrides.delete(oldest);
		}

		this.cachedLibraryOverrides.set(libraryId, { expiresAt: Date.now() + serverConfig.plugins.providers.settingsCacheTtlMs, values });

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
		assertFound(provider, "Metadata provider", providerId);
		await metadataProviderSettingsRepository.upsert(providerId, values);
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

		await metadataProviderSettingsRepository.reorder(providerIds);
		this.invalidateCache();

		return this.list();
	}

	invalidateCache(): void {
		this.cachedSettings = undefined;
		this.cachedOrdered = undefined;
		this.cachedLibraryOverrides.clear();
	}

	private async getSettings(): Promise<Map<string, MetadataProviderSetting>> {
		if (this.cachedSettings && this.cachedSettings.expiresAt > Date.now()) return this.cachedSettings.values;

		const persistedSettings = await metadataProviderSettingsRepository.list();

		const values = toMap(persistedSettings, (setting) => setting.providerId);
		this.cachedSettings = { expiresAt: Date.now() + serverConfig.plugins.providers.settingsCacheTtlMs, values };

		return values;
	}
}

export const metadataProviderSettingsService = new MetadataProviderSettingsService();
