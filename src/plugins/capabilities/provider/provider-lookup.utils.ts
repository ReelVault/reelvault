import type { MetadataProvider, ProviderMediaType, ProviderSearchResult } from "@reelvault/sdk/plugin";
import { metadataProviderSettingsService } from "@/plugins/capabilities/metadata-provider-settings.service";
import { pluginRegistry } from "@/plugins/lifecycle/plugin.registry";
import { pluginEventBus } from "@/system/extensions/plugin.events";
import { createLogger } from "@/utils/logger.utils";
import { rankCandidates } from "@/utils/media-match/ranking.utils";
import type { ScoredCandidate } from "@/utils/media-match/score.constants";
import type { SafeExecuteContext } from "@/utils/safe-execute.utils";
import { searchWithVariants } from "./query-variants.service";

/** The name and logger the metadata provider lookups report through. */
export const providerLog: SafeExecuteContext = { serviceName: "ProviderService", logger: createLogger("ProviderService") };

/**
 * Cache-key prefix: the ordered provider ids (per-library overrides included when a library is given) plus the
 * registry generation. Derived on every call, so a priority or enabled change misses the provider-scoped caches,
 * and a reload of a provider with the same id cannot serve results of its previous implementation.
 */
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
