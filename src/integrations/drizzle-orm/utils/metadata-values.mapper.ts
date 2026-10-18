import type { ProviderMetadataResult } from "@reelvault/sdk/plugin";

/**
 * Provider-derived scalar metadata fields shared by the metadata create and
 * rematch paths. `matchScore` is only included when supplied; callers that
 * always want one (rematch) pass their own default in.
 */
export function toMetadataValues(results: ProviderMetadataResult, providerName: string, matchScore?: number) {
	return {
		primaryProviderId: providerName,
		title: results.title,
		originalTitle: results.originalTitle,
		overview: results.overview,
		tagline: results.tagline,
		releaseDate: results.releaseDate,
		status: results.status,
		budget: results.budget,
		revenue: results.revenue,
		popularity: results.popularity,
		hasMissingTranslation: results.hasMissingTranslation ?? false,
		...(matchScore !== undefined ? { matchScore } : {}),
	};
}
