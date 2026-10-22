import type {
	MetadataProvider,
	ProviderDiscoveryRequest,
	ProviderDiscoveryResult,
	ProviderImageResult,
	ProviderMediaType,
	ProviderResultGenre,
} from "@reelvault/sdk/plugin";
import { pluginRegistry } from "@/plugins/lifecycle/plugin.registry";
import { errorMessage } from "@/utils/domain.errors";
import { fetchFromEveryProvider } from "./fan-out.service";
import { providerCaches } from "./inflight.cache";
import { discoveryCacheKey } from "./match-ranking.utils";
import type { ProviderPersonDetails, ProviderResultCache } from "./provider.types";
import { getProviderKey, providerLog, resolveProviders } from "./provider-lookup.utils";

/**
 * Walks providers in priority order and returns the first result `isPositive`
 * accepts, caching it under `cacheKey`. A provider without the capability
 * (fetchOne resolves to undefined) is skipped; a provider that throws is
 * reported through `onError` and skipped. Negative results are never cached,
 * so a temporarily down provider recovers on the next call.
 */
async function firstProviderResult<TResult>(
	providerId: string | undefined,
	slot: { cacheKey: string; cache: ProviderResultCache<TResult> },
	fetchOne: (provider: MetadataProvider) => Promise<TResult | undefined>,
	isPositive: (result: TResult) => boolean,
	onError: (provider: MetadataProvider, error: unknown) => void,
): Promise<TResult | null> {
	const { cacheKey, cache } = slot;
	const cached = cache.get(cacheKey);
	if (cached) return cached;

	for (const provider of await resolveProviders(providerId)) {
		try {
			const result = await fetchOne(provider);
			if (result !== undefined && isPositive(result)) {
				cache.set(cacheKey, result);

				return result;
			}
		} catch (error) {
			onError(provider, error);
		}
	}

	return null;
}

/**
 * Curated discovery feed (trending/popular/upcoming/…). Resolves through the
 * enabled providers in priority order and returns the first provider that
 * supports the category and yields items. Positive results are cached; a
 * miss is retried on the next call so a temporarily down provider recovers.
 */
export async function discover(request: ProviderDiscoveryRequest): Promise<ProviderDiscoveryResult | null> {
	const cacheKey = discoveryCacheKey(request);

	return await firstProviderResult(
		request.providerId,
		{ cacheKey, cache: providerCaches().discovery },
		async (provider) => {
			const page = await provider.discover?.(request);

			return page ? { providerId: provider.id, ...page } : undefined;
		},
		(result) => result.items.length > 0,
		(provider, error) =>
			providerLog.logger.warn("Metadata provider discovery failed, trying next provider", {
				providerId: provider.id,
				category: request.category,
				error: errorMessage(error),
			}),
	);
}

/** Genre catalogue from the first enabled provider that exposes it. */
export async function getGenres(type: ProviderMediaType, providerId?: string): Promise<ProviderResultGenre[]> {
	const cacheKey = `genres:${providerId ?? "*"}:${type}`;
	const genres = await firstProviderResult(
		providerId,
		{ cacheKey, cache: providerCaches().genres },
		(provider) => Promise.resolve(provider.getGenres?.(type)),
		(result) => result.length > 0,
		(provider, error) =>
			providerLog.logger.warn("Metadata provider genre lookup failed, trying next provider", {
				providerId: provider.id,
				type,
				error: errorMessage(error),
			}),
	);

	return genres ?? [];
}

/** Fetches selectable artwork from one provider without changing persisted metadata. */
export async function fetchImagesByProvider(
	providerId: string,
	type: "movie" | "tv_show",
	externalId: string,
): Promise<ProviderImageResult[]> {
	const provider = pluginRegistry.getProvider(providerId);
	if (!provider?.getImages) return [];

	try {
		return (await provider.getImages(type, externalId)).filter((image) => Boolean(image.url));
	} catch (error) {
		providerLog.logger.error(`Provider ${providerId} image lookup failed`, error);

		return [];
	}
}

export async function fetchPerson(externalId: string): Promise<ProviderPersonDetails[]> {
	const providerKey = await getProviderKey();
	const key = `${providerKey}:${externalId}`;

	return await providerCaches().person.getOrSet(key, () =>
		fetchFromEveryProvider(async (provider) => {
			if (typeof provider.getPersonDetails === "function") {
				return await provider.getPersonDetails(externalId);
			}

			return null;
		}),
	);
}
