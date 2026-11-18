import { isNotNullish } from "@/utils/type.utils";

const RATING_DEFAULT_SOURCE_WEIGHT = 1;

export type RatingAggregationStrategy = "votes" | "simple";

function ratingSourceWeight(votes: number | null | undefined): number {
	if (!votes || votes <= 0) return RATING_DEFAULT_SOURCE_WEIGHT;

	return 1 + Math.log10(1 + votes);
}

/**
 * Averages provider ratings on a /10 scale. The default `votes` strategy weights
 * each source by its vote count (log-scaled, floor 1) so high-volume sources like
 * IMDb dominate over sources without votes while still contributing to the blend;
 * `simple` averages every source equally. Configurable via `metadata.ratingAggregation`.
 */
export function calculateAverageScore(
	ratings: Array<{ value?: number | null; maxValue?: number | null; votes?: number | null } | null | undefined>,
	strategy: RatingAggregationStrategy = "votes",
): number | undefined {
	const validRatings = ratings.filter((rating) => isNotNullish(rating));
	if (validRatings.length === 0) {
		return undefined;
	}

	if (strategy === "simple") {
		let totalScore = 0;
		for (const rating of validRatings) {
			const value = rating.value ?? 0;
			const maxValue = rating.maxValue ?? 10;
			totalScore += (value / maxValue) * 10;
		}

		return Math.round((totalScore / validRatings.length) * 100) / 100;
	}

	let weightedScore = 0;
	let totalWeight = 0;
	for (const rating of validRatings) {
		const value = rating.value ?? 0;
		const maxValue = rating.maxValue ?? 10;
		const weight = ratingSourceWeight(rating.votes);
		weightedScore += (value / maxValue) * 10 * weight;
		totalWeight += weight;
	}

	if (totalWeight <= 0) return undefined;

	return Math.round((weightedScore / totalWeight) * 100) / 100;
}
