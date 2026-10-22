import type { MetadataProviderConfiguration, MetadataProviderStatus } from "@reelvault/sdk/common";
import { pluginRegistry } from "@/plugins/lifecycle/plugin.registry";
import { metadataProviderSettingsService } from "./metadata-provider-settings.service";
import { discover, fetchImagesByProvider, fetchPerson, getGenres } from "./provider/catalog.service";
import {
	fetchAggregatedDetails,
	fetchAggregatedDetailsByProvider,
	fetchDetails,
	fetchDetailsByLocalIdentifiers,
	fetchDetailsByProvider,
	resolveDetails,
} from "./provider/details.service";
import { resetProviderCaches } from "./provider/inflight.cache";
import { fetchEpisodeFromLinks, fetchSeasonByProvider, fetchSeasonFromLinks } from "./provider/links.service";
import { search, searchProviders } from "./provider/search.service";

export type { ProviderDetails, ProviderEpisodeDetails, ProviderPersonDetails, ProviderSeasonDetails } from "./provider/provider.types";

/**
 * Metadata lookups across the enabled provider plugins, in priority order, with
 * provider-scoped result caches. The lookups live in `provider/`: search, details
 * and aggregation, season and episode links, and the catalog reads.
 */
export const providerService = {
	/** Replaces the result caches, so a changed cache TTL takes effect. */
	resetCaches: resetProviderCaches,
	search,
	/** Title search across enabled providers (or one `providerId`), keeping each provider's richer search result. */
	searchProviders,
	/** Deduplicates concurrent detail lookups for the same title/year so a burst of requests only hits providers once. */
	fetchDetails,
	/**
	 * Searches every enabled provider, then merges the details of all that matched: the highest-priority provider
	 * anchors each field, lower-priority ones fill gaps, and ratings are collected from every source.
	 */
	fetchAggregatedDetails,
	/** A known provider entity without a title search first: the persisted provider/external-id pair is authoritative. */
	fetchDetailsByProvider,
	/** The aggregated shape of one provider's exact title, for a title named by its id; null when the provider does not know it. */
	fetchAggregatedDetailsByProvider: (
		providerId: string,
		type: "movie" | "tv_show",
		externalId: string,
		options: { language?: string | undefined } = {},
	) => fetchAggregatedDetailsByProvider({ providerId, type, externalId }, options),
	/** Resolves a title to the best matching provider's full metadata (no aggregation). */
	resolveDetails,
	/** Curated discovery feed from the first enabled provider that supports the category and yields items. */
	discover,
	/** Genre catalogue from the first enabled provider that exposes it. */
	getGenres,
	fetchDetailsByLocalIdentifiers,
	/** Selectable artwork from one provider, without changing persisted metadata. */
	fetchImagesByProvider,
	/** A season from every linked provider, each through its own series id, in provider priority order. */
	fetchSeasonFromLinks,
	fetchEpisodeFromLinks,
	/** One season from one provider's namespace, without persisted links (plugin capability path); misses are cached too. */
	fetchSeasonByProvider,
	fetchPerson,
	getAll: (): MetadataProviderStatus[] => pluginRegistry.getProviderStatus(),
	getConfigurations: (): Promise<MetadataProviderConfiguration[]> => metadataProviderSettingsService.list(),
	reorderConfigurations: (providerIds: readonly string[]): Promise<MetadataProviderConfiguration[]> =>
		metadataProviderSettingsService.reorder(providerIds),
	updateConfiguration: (providerId: string, values: { priority?: number; enabled?: boolean }): Promise<MetadataProviderConfiguration> =>
		metadataProviderSettingsService.update(providerId, values),
};
