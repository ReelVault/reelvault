import type { MetadataProviderSearchRequest, MetadataProviderSearchResponse } from "@reelvault/sdk/common";
import type { ProviderSearchRequest, ProviderSearchResponse } from "@reelvault/sdk/plugin";
import { serverConfig } from "@/config/server/server.config";
import { isNotNullish } from "@/utils/array.utils";
import { DomainError } from "@/utils/domain.errors";
import { PromiseUtils } from "@/utils/promise.utils";
import { type fetchDetailsByProvider, searchByProviderExternalId } from "./details.service";
import type { ProviderServiceState, WithoutState } from "./shared.utils";
import { publishSearchRequested, rankProviderResults, resolveProviders } from "./shared.utils";

export async function search(
	request: MetadataProviderSearchRequest,
	searchProvidersOf: (...args: WithoutState<typeof searchProviders>) => ReturnType<typeof searchProviders>,
	fetchByProvider: (...args: WithoutState<typeof fetchDetailsByProvider>) => ReturnType<typeof fetchDetailsByProvider>,
): Promise<MetadataProviderSearchResponse[]> {
	const { type, title, year } = request;
	const providerId = request.providerId?.trim();
	const externalId = request.externalId?.trim();
	if (providerId || externalId) {
		if (!(providerId && externalId))
			throw new DomainError("validation", "Searching by id requires both providerId and externalId", {
				code: "provider.search_id_incomplete",
			});

		return await searchByProviderExternalId(type, providerId, externalId, fetchByProvider);
	}

	const query = title?.trim();
	if (!query)
		throw new DomainError("validation", "Provide a title or a providerId + externalId pair to search", {
			code: "provider.search_query_missing",
		});

	const grouped = await searchProvidersOf({ type, query, year });

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
export async function searchProviders(state: ProviderServiceState, request: ProviderSearchRequest): Promise<ProviderSearchResponse[]> {
	const query = request.query.trim();
	if (!query) return [];

	publishSearchRequested(request.type, query, request.year);
	const providers = await resolveProviders(request.providerId);

	const results = await PromiseUtils.mapConcurrent(
		providers,
		serverConfig.plugins.providers.concurrency,
		async (provider): Promise<ProviderSearchResponse | null> => {
			const ranked = await rankProviderResults(provider, { type: request.type, query, year: request.year, language: undefined }, (error) =>
				state.logger.error(`Provider ${provider.id} failed`, error),
			);
			if (!ranked) return null;

			return { providerId: provider.id, results: ranked.map((candidate) => candidate.item) };
		},
	);

	return results.filter((result) => isNotNullish(result));
}
