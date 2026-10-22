import type { MetadataProviderSearchRequest, MetadataProviderSearchResponse } from "@reelvault/sdk/common";
import type { ProviderSearchRequest, ProviderSearchResponse } from "@reelvault/sdk/plugin";
import { DomainError } from "@/utils/domain.errors";
import { searchByProviderExternalId } from "./details.service";
import { mapProvidersSafely } from "./fan-out.service";
import { providerLog, publishSearchRequested, rankProviderResults, resolveProviders } from "./provider-lookup.utils";

export async function search(request: MetadataProviderSearchRequest): Promise<MetadataProviderSearchResponse[]> {
	const { type, title, year } = request;
	const providerId = request.providerId?.trim();
	const externalId = request.externalId?.trim();
	if (providerId || externalId) {
		if (!(providerId && externalId))
			throw new DomainError("validation", "Searching by id requires both providerId and externalId", {
				code: "provider.search_id_incomplete",
			});

		return await searchByProviderExternalId(type, providerId, externalId);
	}

	const query = title?.trim();
	if (!query)
		throw new DomainError("validation", "Provide a title or a providerId + externalId pair to search", {
			code: "provider.search_query_missing",
		});

	const grouped = await searchProviders({ type, query, year });

	return grouped.map((group) => ({
		providerId: group.providerId,
		results: group.results.map((item) => ({
			externalId: item.externalId,
			title: item.title,
			releaseDate: item.releaseDate,
			...(item.posterPath ? { posterPath: item.posterPath } : {}),
		})),
	}));
}

/**
 * Title search across enabled providers (or a single `providerId`), with the
 * provider's richer search result retained for callers that need artwork and
 * popularity. Shared by the HTTP search endpoint and the plugin capability.
 */
export async function searchProviders(request: ProviderSearchRequest): Promise<ProviderSearchResponse[]> {
	const query = request.query.trim();
	if (!query) return [];

	publishSearchRequested(request.type, query, request.year);
	const providers = await resolveProviders(request.providerId);

	return await mapProvidersSafely(
		providers,
		async (provider): Promise<ProviderSearchResponse | null> => {
			const ranked = await rankProviderResults(provider, { type: request.type, query, year: request.year, language: undefined }, (error) =>
				providerLog.logger.error(`Provider ${provider.id} failed`, error),
			);
			if (!ranked) return null;

			return { providerId: provider.id, results: ranked.map((candidate) => candidate.item) };
		},
		() => {
			// rankProviderResults reports per-provider failures through its own callback.
		},
	);
}
