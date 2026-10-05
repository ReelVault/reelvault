import type { ProfileInsights, WrappedInsights } from "@reelvault/sdk/common";
import { MemoryCache } from "@/utils/memory-cache";
import { invalidateProfileResponseBodies } from "@/utils/response-body-cache";
import { discoverService } from "./discover.service";

const INSIGHTS_CACHE_TTL_MS = 30_000;
const INSIGHTS_CACHE_MAX_SIZE = 200;

/**
 * Profile-scoped insight caches live here (not on the service) so the
 * invalidation helper below can reach them without importing the service.
 */
export const profileInsightsCache = new MemoryCache<ProfileInsights>({
	ttlMs: INSIGHTS_CACHE_TTL_MS,
	maxSize: INSIGHTS_CACHE_MAX_SIZE,
	name: "profile-insights",
});

export const wrappedInsightsCache = new MemoryCache<WrappedInsights>({
	ttlMs: INSIGHTS_CACHE_TTL_MS,
	maxSize: INSIGHTS_CACHE_MAX_SIZE,
	name: "wrapped-insights",
});

/** Drops the insight entries of one profile (cache keys are `${profileId}:...`). */
export function clearProfileInsights(profileId: string): void {
	for (const key of profileInsightsCache.keys()) {
		if (key.startsWith(`${profileId}:`)) profileInsightsCache.delete(key);
	}

	for (const key of wrappedInsightsCache.keys()) {
		if (key.startsWith(`${profileId}:`)) wrappedInsightsCache.delete(key);
	}
}

/** Drops every profile-scoped cache after a write: discover view, insights and cached response bodies. */
export function invalidateProfileCaches(profileId: string): void {
	discoverService.clearCache(profileId);
	clearProfileInsights(profileId);
	invalidateProfileResponseBodies(profileId);
}
