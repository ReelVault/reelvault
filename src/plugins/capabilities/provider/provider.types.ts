import type {
	MetadataProvider,
	ProviderEpisodeResult,
	ProviderMetadataResult,
	ProviderPersonResult,
	ProviderSeasonResult,
} from "@reelvault/sdk/plugin";
import type { ScoredCandidate } from "@/utils/media-match/score.constants";
import type { SearchCandidate } from "./query-variants.service";

export interface ProviderDetails {
	provider: string;
	metadata: ProviderMetadataResult;
	matchScore?: number | undefined;
}

export interface ProviderSeasonDetails {
	provider: string;
	metadata: ProviderSeasonResult;
}

export interface ProviderEpisodeDetails {
	provider: string;
	metadata: ProviderEpisodeResult;
}

export interface ProviderPersonDetails {
	provider: string;
	metadata: ProviderPersonResult;
}

export interface AcceptedMatch {
	provider: MetadataProvider;
	index: number;
	bestMatch: ScoredCandidate<SearchCandidate>;
}

/** A metadata provider plus that provider's own id for the entity (not the title's primary id). */
export interface ProviderLink {
	providerId: string;
	externalId: string;
}

/** Minimal cache surface used by first-provider lookups — only positive results are ever stored. */
export interface ProviderResultCache<TResult> {
	get(key: string): TResult | null;
	set(key: string, value: TResult): void;
}

/** Thrown inside getOrSet loaders to signal "no match" without caching the null result. */
export class NoMatchError extends Error {
	constructor() {
		super("No metadata provider match found");
		this.name = "NoMatchError";
	}
}
