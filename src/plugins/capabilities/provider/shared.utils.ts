import type { MetadataProvider, ProviderMediaType, ProviderSearchResult } from "@reelvault/sdk/plugin";
import { metadataProviderSettingsService } from "@/plugins/capabilities/metadata-provider-settings.service";
import { pluginRegistry } from "@/plugins/lifecycle/plugin.registry";
import { pluginEventBus } from "@/system/extensions/plugin.events";
import type { createLogger } from "@/utils/logger.utils";
import { rankCandidates } from "@/utils/media-match/ranking.utils";
import type { ScoredCandidate } from "@/utils/media-match/score.constants";
import type { ProviderResultCaches } from "./inflight.cache";
import { searchWithVariants } from "./query-variants.service";

/** Arguments of a state-taking service function, without the leading state parameter. */
export type WithoutState<F> = F extends (state: never, ...rest: infer R) => unknown ? R : never;

export interface ProviderServiceState {
	readonly logger: ReturnType<typeof createLogger>;
	caches: ProviderResultCaches;
}

/**
 * Derived from the ordered providers on every call so priority/enabled changes
 * invalidate provider-scoped caches. The registry generation is appended so a
 * reload/upgrade of a provider with the same id cannot serve stale results
 * under the previous implementation's key.
 */
/** Cache-key prefix: the ordered provider ids (per-library overrides included when a library is given) + registry generation. */
export async function getProviderKey(libraryId?: string): Promise<string> {
	const providers = await metadataProviderSettingsService.getOrderedProviders(libraryId);

	return `${providers.map((provider) => provider.id).join(",")}#${pluginRegistry.getGeneration()}`;
}

/**
 * Runs one provider's title search through the query variants and returns its
 * ranked candidates, or null when the provider fails or yields no results.
 * `onError` keeps each caller's logging level/context intact.
 */
export async function rankProviderResults(
	provider: MetadataProvider,
	search: { type: ProviderMediaType; query: string; year: number | undefined; language: string | undefined },
	onError: (error: unknown) => void,
): Promise<Array<ScoredCandidate<ProviderSearchResult>> | null> {
	const { type, query, year, language } = search;
	try {
		const results = await searchWithVariants(
			(searchQuery) => (language ? provider.search(type, searchQuery, year, { language }) : provider.search(type, searchQuery, year)),
			query,
			year,
		);
		if (results.length === 0) return null;

		return rankCandidates(results, query, year);
	} catch (error) {
		onError(error);

		return null;
	}
}

/** Ordered enabled providers, optionally narrowed to one provider id. */
export async function resolveProviders(providerId?: string): Promise<MetadataProvider[]> {
	const allProviders = await metadataProviderSettingsService.getOrderedProviders();

	return providerId ? allProviders.filter((provider) => provider.id === providerId) : allProviders;
}

export function publishSearchRequested(type: "movie" | "tv_show", title: string, year?: number): void {
	pluginEventBus.publish("metadata.search.requested", { type, title, year });
}
