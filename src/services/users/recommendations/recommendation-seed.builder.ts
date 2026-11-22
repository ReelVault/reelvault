import type { MetadataType } from "@reelvault/sdk/common";
import { DAY } from "@/config/server/server.constants";
import { releaseYear } from "@/utils/recommendation-feature.utils";
import {
	RECOMMENDATION_MAX_NEGATIVE_SEEDS,
	RECOMMENDATION_MAX_SEEDS,
	RECOMMENDATION_SEED_DECAY,
	RECOMMENDATION_SEED_MAX_WEIGHT,
	RECOMMENDATION_WATCHLIST_SHARE_CAP,
	RECOMMENDATION_WATCHLIST_WEIGHT,
} from "./recommendation.constants";

/** One metadata title the profile has watched, rated or saved. */
export interface RecommendationSeedInput {
	metadataId: string;
	type: MetadataType;
	status: string | null;
	releaseDate: string;
	watchedEpisodes: number;
	totalEpisodes: number | null;
	watchCount: number;
	lastWatchedAt: number | null;
	completionRatio: number;
	isFullWatch: boolean;
	rating: number | null;
	watchlistAddedAt: Date | null;
}

export interface RecommendationSeed {
	metadataId: string;
	type: MetadataType;
	weight: number;
	watchlistOnly: boolean;
}

export interface RecommendationSeedSet {
	/** Watched or explicitly rated titles. */
	positive: RecommendationSeed[];
	/** Saved-but-unwatched titles: cold-start intent, never a substitute for viewing history. */
	watchlist: RecommendationSeed[];
	negative: RecommendationSeed[];
	typeShare: Record<MetadataType, number>;
	watchedWeight: number;
	watchlistWeight: number;
	preferredYear: number | null;
}

interface SeedAccumulator {
	positive: RecommendationSeed[];
	watchlist: RecommendationSeed[];
	watchedWeight: number;
	watchlistWeight: number;
	yearWeightedSum: number;
	yearWeight: number;
}

function recencyDecay(ageDays: number): number {
	const { slowHalfLifeDays, fastHalfLifeDays, slowShare, fastShare, floor } = RECOMMENDATION_SEED_DECAY;
	const slow = 0.5 ** (ageDays / slowHalfLifeDays);
	const fast = 0.5 ** (ageDays / fastHalfLifeDays);

	return Math.max(floor, slow * slowShare + fast * fastShare);
}

function decayForLastActivity(lastWatchedAt: number | null, watchlistAddedAt: Date | null, nowMs: number): number {
	const timestamp = lastWatchedAt ?? watchlistAddedAt?.getTime() ?? null;
	if (timestamp === null || timestamp <= 0) return 0.5;

	return recencyDecay(Math.max(0, (nowMs - timestamp) / DAY));
}

function televisionEngagement(input: RecommendationSeedInput): number {
	const total = Math.max(0, input.totalEpisodes ?? 0);
	const ratio = total > 0 ? Math.min(1, input.watchedEpisodes / total) : Math.min(1, input.watchedEpisodes / 8);

	if (input.watchedEpisodes >= 2) return 0.3 + 0.7 * ratio;
	if (input.watchedEpisodes === 1) return 0.2;
	if (input.completionRatio >= 0.5) return 0.2;

	return 0;
}

function movieEngagement(input: RecommendationSeedInput): 0 | 0.2 | 0.6 | 1 {
	const ratio = Math.max(input.completionRatio, input.isFullWatch ? 1 : 0);

	if (ratio >= 0.8) return 1;
	if (ratio >= 0.4) return 0.6;
	if (ratio >= 0.2) return 0.2;

	return 0;
}

function ratingMultiplier(rating: number | null): 1 | 1.3 {
	if (rating === 2) return 1.3;

	return 1;
}

function watchedEngagement(input: RecommendationSeedInput): number {
	const base = input.type === "tv_show" ? televisionEngagement(input) : movieEngagement(input);
	if (base <= 0) return 0;

	const playsPerEpisode = input.watchedEpisodes > 0 ? input.watchCount / input.watchedEpisodes : input.watchCount;
	const rewatchBonus = playsPerEpisode > 1.2 ? 0.1 * Math.log1p(playsPerEpisode - 1) : 0;

	return Math.min(RECOMMENDATION_SEED_MAX_WEIGHT, base * ratingMultiplier(input.rating) + rewatchBonus);
}

function addWatchedSeed(accumulator: SeedAccumulator, input: RecommendationSeedInput, decay: number): void {
	const engagement = watchedEngagement(input);
	if (engagement <= 0) return;

	const weight = engagement * decay;
	accumulator.positive.push({ metadataId: input.metadataId, type: input.type, weight, watchlistOnly: false });
	accumulator.watchedWeight += weight;

	const year = releaseYear(input.releaseDate);
	if (year !== null) {
		accumulator.yearWeightedSum += year * weight;
		accumulator.yearWeight += weight;
	}
}

function addWatchlistSeed(accumulator: SeedAccumulator, input: RecommendationSeedInput, decay: number): void {
	const weight = RECOMMENDATION_WATCHLIST_WEIGHT * decay;
	accumulator.watchlist.push({ metadataId: input.metadataId, type: input.type, weight, watchlistOnly: true });
	accumulator.watchlistWeight += weight;
}

function buildPositiveSeeds(inputs: readonly RecommendationSeedInput[], nowMs: number): SeedAccumulator {
	const accumulator: SeedAccumulator = {
		positive: [],
		watchlist: [],
		watchedWeight: 0,
		watchlistWeight: 0,
		yearWeightedSum: 0,
		yearWeight: 0,
	};

	for (const input of inputs) {
		if (input.rating === 0) continue;

		const decay = decayForLastActivity(input.lastWatchedAt, input.watchlistAddedAt, nowMs);
		const hasViewed = input.watchedEpisodes > 0 || input.watchCount > 0 || input.completionRatio > 0.05;

		if (hasViewed) {
			addWatchedSeed(accumulator, input, decay);
			continue;
		}

		if (input.watchlistAddedAt) {
			addWatchlistSeed(accumulator, input, decay);
			continue;
		}

		if (input.rating === 2) {
			const weight = 0.35 * decay;
			accumulator.positive.push({ metadataId: input.metadataId, type: input.type, weight, watchlistOnly: false });
			accumulator.watchedWeight += weight;
		}
	}

	return accumulator;
}

function buildNegativeSeeds(inputs: readonly RecommendationSeedInput[], nowMs: number): RecommendationSeed[] {
	const negative: RecommendationSeed[] = [];

	for (const input of inputs) {
		if (input.rating !== 0) continue;

		const decay = decayForLastActivity(input.lastWatchedAt, input.watchlistAddedAt, nowMs);
		negative.push({ metadataId: input.metadataId, type: input.type, weight: 0.5 + 0.5 * decay, watchlistOnly: false });
	}

	return negative.toSorted((left, right) => right.weight - left.weight).slice(0, RECOMMENDATION_MAX_NEGATIVE_SEEDS);
}

function capWatchlistWeight(accumulator: SeedAccumulator): void {
	if (accumulator.watchedWeight <= 0) return;
	if (accumulator.watchlistWeight <= RECOMMENDATION_WATCHLIST_SHARE_CAP * accumulator.watchedWeight) return;

	const scale = (RECOMMENDATION_WATCHLIST_SHARE_CAP * accumulator.watchedWeight) / accumulator.watchlistWeight;
	for (const seed of accumulator.watchlist) {
		seed.weight *= scale;
	}
}

/** Weighted movie/show split of a seed list; an empty list is an even split. */
export function typeShareOf(seeds: readonly RecommendationSeed[]): Record<MetadataType, number> {
	let total = 0;
	let movie = 0;
	for (const seed of seeds) {
		total += seed.weight;
		if (seed.type === "movie") movie += seed.weight;
	}

	if (total <= 0) return { movie: 0.5, tv_show: 0.5 };

	return { movie: movie / total, tv_show: (total - movie) / total };
}

/**
 * Turns raw profile rows into signed seed weights. A binge does not outweigh a
 * whole profile (the show is one seed), a dropped show is not a negative
 * (only an explicit dislike is), and a watchlisted title never outweighs one
 * the profile actually watched.
 */
export function buildRecommendationSeeds(inputs: readonly RecommendationSeedInput[], nowMs: number): RecommendationSeedSet {
	const accumulator = buildPositiveSeeds(inputs, nowMs);
	capWatchlistWeight(accumulator);

	const positive = accumulator.positive.toSorted((left, right) => right.weight - left.weight).slice(0, RECOMMENDATION_MAX_SEEDS);
	const watchlist = accumulator.watchlist.toSorted((left, right) => right.weight - left.weight).slice(0, RECOMMENDATION_MAX_SEEDS);

	return {
		positive,
		watchlist,
		negative: buildNegativeSeeds(inputs, nowMs),
		typeShare: typeShareOf(positive.length > 0 ? positive : watchlist),
		watchedWeight: accumulator.watchedWeight,
		watchlistWeight: accumulator.watchlistWeight,
		preferredYear: accumulator.yearWeight > 0 ? accumulator.yearWeightedSum / accumulator.yearWeight : null,
	};
}
