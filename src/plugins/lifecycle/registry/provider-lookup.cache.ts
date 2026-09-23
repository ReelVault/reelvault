import type { MetadataProvider, ProviderStatus } from "@reelvault/sdk/plugin";
import { ValidationError } from "@/utils/errors";

interface ProviderEntry {
	pluginId: string;
	provider: MetadataProvider;
}

/** Owns the metadata-provider table and its memoized sorted lookups. */
export class ProviderLookupCache {
	private readonly providers = new Map<string, ProviderEntry>();
	private providerCache: MetadataProvider[] | null = null;
	private providerStatusCache: ProviderStatus[] | null = null;

	assertRegisterable(providers: readonly MetadataProvider[]): void {
		for (const provider of providers) {
			if (this.providers.has(provider.id)) {
				throw new ValidationError(
					`Provider "${provider.id}" is already registered by plugin "${this.providers.get(provider.id)?.pluginId ?? "unknown"}"`,
				);
			}
		}
	}

	register(pluginId: string, providers: readonly MetadataProvider[]): void {
		for (const provider of providers) this.providers.set(provider.id, { pluginId, provider });

		this.invalidate();
	}

	removeForPlugin(pluginId: string): void {
		for (const [key, entry] of this.providers) {
			if (entry.pluginId === pluginId) this.providers.delete(key);
		}

		this.invalidate();
	}

	clear(): void {
		this.providers.clear();
		this.invalidate();
	}

	get(providerId: string): MetadataProvider | undefined {
		return this.providers.get(providerId)?.provider;
	}

	getAll(): MetadataProvider[] {
		this.providerCache ??= [...this.providers.values()]
			.map((entry) => entry.provider)
			.toSorted((left, right) => left.id.localeCompare(right.id));

		return this.providerCache;
	}

	getStatuses(): ProviderStatus[] {
		this.providerStatusCache ??= [...this.providers.values()]
			.map(({ pluginId, provider }) => ({ id: provider.id, name: provider.name, version: provider.version, pluginId }))
			.toSorted((left, right) => left.id.localeCompare(right.id));

		return this.providerStatusCache;
	}

	private invalidate(): void {
		this.providerCache = null;
		this.providerStatusCache = null;
	}
}
