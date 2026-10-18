import type {
	ExternalIdentifierAwareProvider,
	ExternalIdentifiers,
	MetadataProvider,
	ProviderDiscoveryRequest,
	ProviderMetadataResult,
} from "@reelvault/sdk/plugin";

export function trimNameAndOverview<T extends { name?: string | undefined; overview?: string | undefined }>(metadata: T): T {
	return {
		...metadata,
		overview: metadata.overview?.trim(),
		name: typeof metadata.name === "string" ? metadata.name.trim() : metadata.name,
	};
}

export function discoveryCacheKey(request: ProviderDiscoveryRequest): string {
	return [
		"discover",
		request.providerId ?? "*",
		request.type,
		request.category,
		request.page ?? 1,
		request.window ?? "",
		request.externalId ?? "",
		request.genreId ?? "",
		request.year ?? "",
		request.language ?? "",
		request.region ?? "",
	].join(":");
}

export function normalizeMetadataDetails(metadata: ProviderMetadataResult): ProviderMetadataResult {
	return {
		...metadata,
		title: metadata.title.trim(),
		originalTitle: metadata.originalTitle?.trim(),
		overview: metadata.overview?.trim(),
		tagline: metadata.tagline?.trim(),
		revenue: metadata.revenue && metadata.revenue > 0 ? metadata.revenue : undefined,
		genres: metadata.genres?.map((genre) => ({ ...genre, name: genre.name.trim() })),
		keywords: metadata.keywords?.map((keyword) => ({ ...keyword, name: keyword.name.trim() })),
		cast: metadata.cast?.filter((cast) => cast.name && cast.role).toSorted((left, right) => (left.order || 0) - (right.order || 0)) ?? [],
	};
}

export function isExternalIdentifierAwareProvider(
	provider: MetadataProvider,
): provider is MetadataProvider & ExternalIdentifierAwareProvider<ProviderMetadataResult> {
	return typeof provider.getDetailsByExternalIds === "function";
}

/**
 * Accepts a provider result when the provider owns one of the requested
 * namespaces, or when its returned external id matches one of the requested
 * identifiers. Keeps identifier-aware providers from returning unrelated data
 * while staying independent of any specific provider (TMDB/IMDb/TVDB/MAL/…).
 */
export function matchesExternalIdentifiers(
	providerId: string,
	metadata: ProviderMetadataResult,
	identifiers: ExternalIdentifiers,
	identifierValues: ReadonlySet<string>,
): boolean {
	if (!metadata.externalId) return false;

	if (Object.hasOwn(identifiers, providerId)) return true;

	return identifierValues.has(metadata.externalId);
}
