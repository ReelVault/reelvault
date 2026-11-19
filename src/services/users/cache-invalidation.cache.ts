import type { ProfileInsights, WrappedInsights } from "@reelvault/sdk/common";
import { MemoryCache } from "@/utils/memory.cache";
import { invalidateProfileResponseBodies } from "@/utils/response-body.cache";
import { discoverService } from "./discover.service";

const INSIGHTS_CACHE_TTL_MS = 30_000;
const INSIGHTS_CACHE_MAX_SIZE = 200;

/**
 * A cache whose keys start with the profile id they belong to.
 *
 * Every profile write (a watchlist toggle, a rating, a finished title) drops
 * that profile's entries. Walking every key to find them turned each write into
 * two full cache scans (each one copying the key list), so the entries are
 * indexed by their profile instead.
 */
export class ProfileScopedCache<T> {
	private readonly cache: MemoryCache<T>;
	private readonly keysByProfile = new Map<string, Set<string>>();

	constructor(options: { ttlMs: number; maxSize: number; name: string }) {
		// An evicted or expired entry leaves the profile index too, so the index never outgrows the cache.
		this.cache = new MemoryCache<T>({ ...options, onEvict: (key) => this.forget(key) });
	}

	getOrSet(key: string, loader: () => Promise<T>): Promise<T> {
		return this.cache.getOrSet(key, async () => {
			const value = await loader();
			this.remember(key);

			return value;
		});
	}

	clear(): void {
		this.cache.clear();
		this.keysByProfile.clear();
	}

	/** Drops the entries of one profile. */
	clearProfile(profileId: string): void {
		const keys = this.keysByProfile.get(profileId);
		if (!keys) return;

		for (const key of keys) this.cache.delete(key);
		this.keysByProfile.delete(profileId);
	}

	private remember(key: string): void {
		const profileId = profileIdOf(key);
		if (!profileId) return;

		const keys = this.keysByProfile.get(profileId) ?? new Set<string>();
		keys.add(key);
		this.keysByProfile.set(profileId, keys);
	}

	private forget(key: string): void {
		const profileId = profileIdOf(key);
		if (!profileId) return;

		const keys = this.keysByProfile.get(profileId);
		if (!keys) return;

		keys.delete(key);
		if (keys.size === 0) this.keysByProfile.delete(profileId);
	}
}

/** The profile id a cache key starts with (`${profileId}:...`), or undefined for a key without one. */
function profileIdOf(key: string): string | undefined {
	const separator = key.indexOf(":");

	return separator <= 0 ? undefined : key.slice(0, separator);
}

/**
 * Profile-scoped insight caches live here (not on the service) so the
 * invalidation helper below can reach them without importing the service.
 */
export const profileInsightsCache = new ProfileScopedCache<ProfileInsights>({
	ttlMs: INSIGHTS_CACHE_TTL_MS,
	maxSize: INSIGHTS_CACHE_MAX_SIZE,
	name: "profile-insights",
});

export const wrappedInsightsCache = new ProfileScopedCache<WrappedInsights>({
	ttlMs: INSIGHTS_CACHE_TTL_MS,
	maxSize: INSIGHTS_CACHE_MAX_SIZE,
	name: "wrapped-insights",
});

/** Drops the insight entries of one profile (cache keys are `${profileId}:...`). */
export function clearProfileInsights(profileId: string): void {
	profileInsightsCache.clearProfile(profileId);
	wrappedInsightsCache.clearProfile(profileId);
}

/** Drops every profile-scoped cache after a write: discover view, insights and cached response bodies. */
export function invalidateProfileCaches(profileId: string): void {
	discoverService.clearCache(profileId);
	clearProfileInsights(profileId);
	invalidateProfileResponseBodies(profileId);
}
