import type { ProviderDiscoveryResult, ProviderResultGenre } from "@sdk/plugin";
import { serverConfig } from "@/server.config";
import { MemoryCache } from "@/utils/memory-cache";
import type { AggregatedMetadata } from "../metadata-aggregator";
import type { ProviderDetails, ProviderEpisodeDetails, ProviderPersonDetails, ProviderSeasonDetails } from "../provider.service";

/**
 * Every provider-scoped result cache shares one TTL/maxSize configuration and
 * one lifetime: entries are keyed by the ordered-provider list + registry
 * generation, so priority changes and reloads miss the cache naturally.
 */
export class ProviderResultCaches {
	readonly details = new MemoryCache<ProviderDetails[]>({ ...providerCacheOptions(), name: "provider-details" });
	readonly aggregatedDetails = new MemoryCache<AggregatedMetadata>({ ...providerCacheOptions(), name: "provider-aggregated-details" });
	readonly season = new MemoryCache<ProviderSeasonDetails[]>({ ...providerCacheOptions(), name: "provider-season" });
	readonly episode = new MemoryCache<ProviderEpisodeDetails[]>({ ...providerCacheOptions(), name: "provider-episode" });
	readonly person = new MemoryCache<ProviderPersonDetails[]>({ ...providerCacheOptions(), name: "provider-person" });
	readonly discovery = new MemoryCache<ProviderDiscoveryResult>({ ...providerCacheOptions(), name: "provider-discovery" });
	readonly genres = new MemoryCache<ProviderResultGenre[]>({ ...providerCacheOptions(), name: "provider-genres" });
}

function providerCacheOptions() {
	return {
		// TTL captured at construction; server restart applies TTL setting changes.
		ttlMs: serverConfig.plugins.providers.detailsCacheTtlMs,
		maxSize: serverConfig.plugins.providers.detailsCacheMaxSize,
	};
}
