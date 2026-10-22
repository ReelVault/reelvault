import type { ProviderDiscoveryResult, ProviderResultGenre } from "@reelvault/sdk/plugin";
import { serverConfig } from "@/config/server/server.config";
import type { AggregatedMetadata } from "@/plugins/capabilities/metadata-aggregator.service";
import type {
	ProviderDetails,
	ProviderEpisodeDetails,
	ProviderPersonDetails,
	ProviderSeasonDetails,
} from "@/plugins/capabilities/provider.service";
import { MemoryCache } from "@/utils/memory.cache";

const PROVIDER_CACHE_COUNT = 7;

/**
 * Every provider-scoped result cache shares one TTL and one total entry budget,
 * and one lifetime: entries are keyed by the ordered-provider list + registry
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
		// The server setting is a total across these caches, not a per-cache limit.
		maxSize: Math.max(1, Math.floor(serverConfig.plugins.providers.detailsCacheMaxSize / PROVIDER_CACHE_COUNT)),
	};
}

let caches = new ProviderResultCaches();

/** The live provider result caches. */
export function providerCaches(): ProviderResultCaches {
	return caches;
}

/**
 * Replaces the result caches. Their TTL is read when they are built, so a changed
 * `plugins.providers.detailsCacheTtlMs` takes effect only through fresh caches.
 */
export function resetProviderCaches(): void {
	caches = new ProviderResultCaches();
}
