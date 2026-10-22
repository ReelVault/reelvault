import type { MetadataProvider, ProviderSeasonResult } from "@reelvault/sdk/plugin";
import { metadataProviderSettingsService } from "@/plugins/capabilities/metadata-provider-settings.service";
import { pluginRegistry } from "@/plugins/lifecycle/plugin.registry";
import { fetchFromEveryProvider, fetchFromProviders } from "./fan-out.service";
import { providerCaches } from "./inflight.cache";
import type { ProviderEpisodeDetails, ProviderLink, ProviderSeasonDetails } from "./provider.types";
import { getProviderKey } from "./provider-lookup.utils";

/**
 * Fetches a season from every linked provider using that provider's own
 * series id — a title may be anchored by one provider but its seasons may
 * have come from another (lower-priority) provider, so a single external id
 * cannot address all of them. Results are ordered by provider priority.
 */
export async function fetchSeasonFromLinks(
	links: readonly ProviderLink[],
	seasonNumber: number,
	language?: string,
): Promise<ProviderSeasonDetails[]> {
	return await fetchFromLinksCached(providerCaches().season, "season", `${seasonNumber}:${language ?? ""}`, links, (ordered) =>
		fetchFromProviderLinks(ordered, (provider, externalId) =>
			provider.getSeasonDetails(externalId, seasonNumber, language ? { language } : undefined),
		),
	);
}

export async function fetchEpisodeFromLinks(
	links: readonly ProviderLink[],
	seasonNumber: number,
	episodeNumber: number,
	language?: string,
): Promise<ProviderEpisodeDetails[]> {
	return await fetchFromLinksCached(
		providerCaches().episode,
		"episode",
		`${seasonNumber}:${episodeNumber}:${language ?? ""}`,
		links,
		(ordered) =>
			fetchFromProviderLinks(ordered, (provider, externalId) =>
				provider.getEpisodeDetails(externalId, seasonNumber, episodeNumber, language ? { language } : undefined),
			),
	);
}

/** Orders links by priority, keys the result on the link set and delegates the fetch to the caller's loader. */
async function fetchFromLinksCached<TDetails>(
	cache: { getOrSet(key: string, loader: () => Promise<TDetails[]>): Promise<TDetails[]> },
	prefix: "season" | "episode",
	keySuffix: string,
	links: readonly ProviderLink[],
	load: (ordered: readonly ProviderLink[]) => Promise<TDetails[]>,
): Promise<TDetails[]> {
	const ordered = await orderLinksByPriority(links);
	const key = `${prefix}:${ordered.map((link) => `${link.providerId}:${link.externalId}`).join(",")}:${keySuffix}`;

	return await cache.getOrSet(key, () => load(ordered));
}

/**
 * Fetches a single season from one provider's own namespace without requiring
 * persisted provider links (plugin capability path). An empty result is cached
 * too, so repeated misses don't re-hit the provider.
 */
export async function fetchSeasonByProvider(
	providerId: string,
	externalId: string,
	seasonNumber: number,
): Promise<ProviderSeasonResult | null> {
	if (!pluginRegistry.getProvider(providerId)) return null;

	const key = `season-direct:${await getProviderKey()}:${providerId}:${externalId}:${seasonNumber}`;
	const cached = providerCaches().season.get(key);
	if (cached) return cached[0]?.metadata ?? null;

	const details = await fetchFromProviderLinks([{ providerId, externalId }], (provider, linkExternalId) =>
		provider.getSeasonDetails(linkExternalId, seasonNumber),
	);
	providerCaches().season.set(key, details);

	return details[0]?.metadata ?? null;
}

/** Orders provider links by configured priority; links without a setting keep their relative order at the end. */
async function orderLinksByPriority(links: readonly ProviderLink[]): Promise<ProviderLink[]> {
	const orderedIds = (await metadataProviderSettingsService.getOrderedProviders()).map((provider) => provider.id);
	const position = new Map(orderedIds.map((id, index) => [id, index] as const));

	return [...links].toSorted(
		(left, right) =>
			(position.get(left.providerId) ?? Number.MAX_SAFE_INTEGER) - (position.get(right.providerId) ?? Number.MAX_SAFE_INTEGER),
	);
}

/** Like {@link fetchFromEveryProvider}, but each provider is queried with its own external id. */
async function fetchFromProviderLinks<TMetadata extends { name?: string | undefined; overview?: string | undefined }>(
	links: readonly ProviderLink[],
	fetchOne: (provider: MetadataProvider, externalId: string) => Promise<TMetadata | null | undefined>,
): Promise<Array<{ provider: string; metadata: TMetadata }>> {
	return await fetchFromProviders(
		links.map((link) => ({
			providerId: link.providerId,
			provider: pluginRegistry.getProvider(link.providerId),
			externalId: link.externalId,
		})),
		(provider, entry) => fetchOne(provider, entry.externalId),
	);
}
