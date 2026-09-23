import type { ProviderMetadataResult, ProviderRating } from "@reelvault/sdk/plugin";
import { ValidationError } from "@/utils/errors";
import { isValidRating } from "@/utils/math.utils";
import { isNonEmptyString } from "@/utils/type.utils";

export interface ProviderContribution {
	providerId: string;
	externalId: string;
	matchScore?: number | undefined;
	metadata: ProviderMetadataResult;
}

export interface AggregatedProviderLink {
	providerId: string;
	externalId: string;
	matchScore?: number | undefined;
}

export interface AggregatedMetadata {
	primaryProviderId: string;
	metadata: ProviderMetadataResult;
	providers: AggregatedProviderLink[];
	matchScore?: number | undefined;
}

/**
 * Merges provider contributions in priority order (highest priority first).
 * Scalars, artwork, seasons and relation arrays come from the first provider
 * that supplies a non-empty value — lower-priority providers only fill gaps.
 * Ratings are the exception: every source from every provider is kept and
 * de-duplicated by `source`, with the highest-priority provider winning ties.
 */
export function mergeProviderMetadata(contributions: readonly ProviderContribution[]): AggregatedMetadata {
	const primary = contributions[0];
	if (!primary) throw new ValidationError("Cannot merge zero provider contributions", { code: "zero_provider_contributions" });

	const metadata: ProviderMetadataResult = {
		...primary.metadata,
		title: firstNonEmptyString(contributions, (m) => m.title) ?? primary.metadata.title,
		originalTitle: firstNonEmptyString(contributions, (m) => m.originalTitle),
		overview: firstNonEmptyString(contributions, (m) => m.overview),
		tagline: firstNonEmptyString(contributions, (m) => m.tagline),
		releaseDate: firstNonEmptyString(contributions, (m) => m.releaseDate) ?? primary.metadata.releaseDate,
		status: firstNonEmptyString(contributions, (m) => m.status),
		budget: firstDefined(contributions, (m) => m.budget),
		revenue: firstDefined(contributions, (m) => m.revenue),
		popularity: firstDefined(contributions, (m) => m.popularity),
		posterPath: firstNonEmptyString(contributions, (m) => m.posterPath),
		backdropPath: firstNonEmptyString(contributions, (m) => m.backdropPath),
		logoPath: firstNonEmptyString(contributions, (m) => m.logoPath),
		hasMissingTranslation: contributions.some((contribution) => contribution.metadata.hasMissingTranslation === true),
		genres: firstNonEmptyArray(contributions, (m) => m.genres),
		productionCompanies: firstNonEmptyArray(contributions, (m) => m.productionCompanies),
		keywords: firstNonEmptyArray(contributions, (m) => m.keywords),
		collection: firstNonEmptyArray(contributions, (m) => m.collection),
		cast: firstNonEmptyArray(contributions, (m) => m.cast),
		crew: firstNonEmptyArray(contributions, (m) => m.crew),
		seasons: firstNonEmptyArray(contributions, (m) => m.seasons),
		ratings: mergeRatings(contributions),
	};

	return {
		primaryProviderId: primary.providerId,
		metadata,
		providers: contributions.map((contribution) => ({
			providerId: contribution.providerId,
			externalId: contribution.externalId,
			matchScore: contribution.matchScore,
		})),
		matchScore: primary.matchScore,
	};
}

/** Collects ratings from every contribution, keeping the first occurrence of each source. */
function mergeRatings(contributions: readonly ProviderContribution[]): ProviderRating[] | undefined {
	const bySource = new Map<string, ProviderRating>();
	for (const contribution of contributions) {
		for (const rating of ratingsFromContribution(contribution)) {
			if (!bySource.has(rating.source)) bySource.set(rating.source, rating);
		}
	}

	return bySource.size > 0 ? [...bySource.values()] : undefined;
}

/** Returns a provider's explicit ratings, or synthesizes one from the legacy voteAverage/voteCount pair. */
function ratingsFromContribution(contribution: ProviderContribution): ProviderRating[] {
	const explicit = contribution.metadata.ratings?.filter(isValidRating);
	if (explicit && explicit.length > 0) return explicit;

	if (contribution.metadata.voteAverage === undefined) return [];

	return [
		{
			source: contribution.providerId,
			value: contribution.metadata.voteAverage,
			maxValue: 10,
			votes: contribution.metadata.voteCount,
		},
	];
}

function firstNonEmptyString(
	contributions: readonly ProviderContribution[],
	pick: (metadata: ProviderMetadataResult) => string | undefined,
): string | undefined {
	for (const contribution of contributions) {
		const value = pick(contribution.metadata);
		if (isNonEmptyString(value)) return value;
	}

	return undefined;
}

function firstDefined<T>(
	contributions: readonly ProviderContribution[],
	pick: (metadata: ProviderMetadataResult) => T | undefined | null,
): T | undefined {
	for (const contribution of contributions) {
		const value = pick(contribution.metadata);
		if (value != null) return value;
	}

	return undefined;
}

function firstNonEmptyArray<T>(
	contributions: readonly ProviderContribution[],
	pick: (metadata: ProviderMetadataResult) => T[] | undefined,
): T[] | undefined {
	for (const contribution of contributions) {
		const value = pick(contribution.metadata);
		if (value && value.length > 0) return value;
	}

	return undefined;
}
