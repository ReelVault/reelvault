import type { MetadataProvider, ProviderStatus } from "@reelvault/sdk/plugin";
import { PluginEntityTable } from "./plugin-entity-table";

/**
 * Owns the metadata-provider table and its memoized sorted lookups. Providers
 * are stored through the shared entity table; ordering for status/list reads
 * is normalized here because provider lookups are id-sorted.
 */
export class ProviderLookupCache {
	private readonly table = new PluginEntityTable<MetadataProvider>("Provider");
	private providerCache: MetadataProvider[] | null = null;
	private providerStatusCache: ProviderStatus[] | null = null;

	assertRegisterable(providers: readonly MetadataProvider[]): void {
		this.table.assertRegisterable(providers);
	}

	register(pluginId: string, providers: readonly MetadataProvider[]): void {
		this.table.register(pluginId, providers);
		this.invalidate();
	}

	removeForPlugin(pluginId: string): void {
		this.table.removeForPlugin(pluginId);
		this.invalidate();
	}

	clear(): void {
		this.table.clear();
		this.invalidate();
	}

	get(providerId: string): MetadataProvider | undefined {
		return this.table.get(providerId);
	}

	getAll(): MetadataProvider[] {
		this.providerCache ??= this.table.getAll().toSorted((left, right) => left.id.localeCompare(right.id));

		return this.providerCache;
	}

	getStatuses(): ProviderStatus[] {
		this.providerStatusCache ??= this.table.getStatuses().toSorted((left, right) => left.id.localeCompare(right.id));

		return this.providerStatusCache;
	}

	private invalidate(): void {
		this.providerCache = null;
		this.providerStatusCache = null;
	}
}
