import type { MetadataType } from "@reelvault/sdk/common";
import { cosineSimilarity } from "@/utils/recommendation-feature.utils";
import {
	RECOMMENDATION_MAX_ITEMS_PER_COLLECTION,
	RECOMMENDATION_MAX_ITEMS_PER_CREATOR,
	RECOMMENDATION_MIN_ITEMS_PER_GENRE,
	RECOMMENDATION_MMR_LAMBDA,
} from "./recommendation.constants";
import type { RecommendationScore } from "./recommendation-score.utils";

interface SlateCounts {
	totalByType: Record<MetadataType, number>;
	genre: Map<string, number>;
	creator: Map<string, number>;
	collection: Map<string, number>;
}

function emptyCounts(): SlateCounts {
	return {
		totalByType: { movie: 0, tv_show: 0 },
		genre: new Map(),
		creator: new Map(),
		collection: new Map(),
	};
}

function typeBudget(limit: number, share: number): number {
	if (share < 0.3) return 1;
	if (share > 0.7) return limit;

	return Math.max(1, Math.round(limit * share));
}

function maxSimilarityToSelected(candidate: RecommendationScore, selected: readonly RecommendationScore[]): number {
	let maximum = 0;
	for (const item of selected) {
		const similarity = cosineSimilarity(candidate.vector, item.vector);
		if (similarity > maximum) maximum = similarity;
	}

	return maximum;
}

function canSelect(
	candidate: RecommendationScore,
	counts: SlateCounts,
	options: { limit: number; typeShare: Record<MetadataType, number>; enforceTypeBudget: boolean; enforceCaps: boolean },
): boolean {
	const { limit, typeShare } = options;
	if (options.enforceTypeBudget && counts.totalByType[candidate.candidate.type] >= typeBudget(limit, typeShare[candidate.candidate.type])) {
		return false;
	}
	// One franchise or one crew member never fills a row, however short the slate.
	for (const creatorId of candidate.creatorIds) {
		if ((counts.creator.get(creatorId) ?? 0) >= RECOMMENDATION_MAX_ITEMS_PER_CREATOR) return false;
	}
	for (const collectionId of candidate.collectionIds) {
		if ((counts.collection.get(collectionId) ?? 0) >= RECOMMENDATION_MAX_ITEMS_PER_COLLECTION) return false;
	}

	// The genre spread is only enforced when there is a surplus to choose from.
	if (!options.enforceCaps) return true;

	const genreLimit = Math.max(RECOMMENDATION_MIN_ITEMS_PER_GENRE, Math.floor(limit / 3));

	return !(candidate.primaryGenreId && (counts.genre.get(candidate.primaryGenreId) ?? 0) >= genreLimit);
}

function remember(candidate: RecommendationScore, counts: SlateCounts): void {
	counts.totalByType[candidate.candidate.type] += 1;

	if (candidate.primaryGenreId) counts.genre.set(candidate.primaryGenreId, (counts.genre.get(candidate.primaryGenreId) ?? 0) + 1);
	for (const creatorId of candidate.creatorIds) {
		counts.creator.set(creatorId, (counts.creator.get(creatorId) ?? 0) + 1);
	}
	for (const collectionId of candidate.collectionIds) {
		counts.collection.set(collectionId, (counts.collection.get(collectionId) ?? 0) + 1);
	}
}

function bestMmrCandidate(
	remaining: readonly RecommendationScore[],
	selected: readonly RecommendationScore[],
	counts: SlateCounts,
	options: { limit: number; typeShare: Record<MetadataType, number>; enforceCaps: boolean },
): RecommendationScore | null {
	let best: RecommendationScore | null = null;
	let bestScore = Number.NEGATIVE_INFINITY;

	for (const candidate of remaining) {
		if (selected.includes(candidate)) continue;
		if (!canSelect(candidate, counts, { ...options, enforceTypeBudget: true })) continue;

		const diversity = maxSimilarityToSelected(candidate, selected);
		const mmr = RECOMMENDATION_MMR_LAMBDA * candidate.score - (1 - RECOMMENDATION_MMR_LAMBDA) * diversity;

		if (mmr > bestScore || (mmr === bestScore && best !== null && candidate.candidate.id < best.candidate.id)) {
			best = candidate;
			bestScore = mmr;
		}
	}

	return best;
}

interface SlateOptions {
	minimumItems: number;
	topSeedIds?: readonly string[];
}

interface FillMinimumOptions {
	limit: number;
	typeShare: Record<MetadataType, number>;
	minimumItems: number;
	enforceCaps: boolean;
}

/** One leader per strongest seed bucket, so one taste cannot crowd out the rest. */
function fillSeedBuckets(
	selected: RecommendationScore[],
	counts: SlateCounts,
	remaining: readonly RecommendationScore[],
	options: { topSeedIds: readonly string[]; limit: number; typeShare: Record<MetadataType, number>; enforceCaps: boolean },
): void {
	for (const seedId of options.topSeedIds) {
		if (selected.length >= options.limit) return;

		let best: RecommendationScore | null = null;
		for (const candidate of remaining) {
			if (candidate.topSeedId !== seedId || selected.includes(candidate)) continue;
			if (!canSelect(candidate, counts, { ...options, enforceTypeBudget: true })) continue;
			if (best === null || candidate.score > best.score) best = candidate;
		}

		if (best) {
			selected.push(best);
			remember(best, counts);
		}
	}
}

function fillToMinimum(
	selected: RecommendationScore[],
	counts: SlateCounts,
	fallback: readonly RecommendationScore[],
	options: FillMinimumOptions,
): void {
	const sorted = fallback.toSorted((left, right) => right.score - left.score);

	for (const candidate of sorted) {
		if (selected.length >= options.minimumItems) return;
		if (selected.includes(candidate)) continue;
		if (!canSelect(candidate, counts, { ...options, enforceTypeBudget: false })) continue;

		selected.push(candidate);
		remember(candidate, counts);
	}
}

/**
 * Greedy MMR rerank with franchise and person caps (always), a genre cap (with a surplus) and a type budget. A
 * short slate is intentional: the caller only backfills to the minimum, never
 * to the requested limit, so an unrelated popular title cannot manufacture
 * relevance.
 */
export function buildRecommendationSlate(
	qualified: readonly RecommendationScore[],
	fallback: readonly RecommendationScore[],
	limit: number,
	typeShare: Record<MetadataType, number>,
	options: SlateOptions,
): RecommendationScore[] {
	const selected: RecommendationScore[] = [];
	const counts = emptyCounts();
	const remaining = qualified.toSorted((left, right) => right.score - left.score);
	const enforceCaps = qualified.length > limit;

	fillSeedBuckets(selected, counts, remaining, { topSeedIds: options.topSeedIds ?? [], limit, typeShare, enforceCaps });
	while (selected.length < limit) {
		const best = bestMmrCandidate(remaining, selected, counts, { limit, typeShare, enforceCaps });
		if (!best) break;

		selected.push(best);
		remember(best, counts);
	}

	if (selected.length < options.minimumItems) {
		fillToMinimum(selected, counts, fallback, { limit, typeShare, minimumItems: options.minimumItems, enforceCaps });
	}

	return selected.toSorted((left, right) => right.score - left.score);
}
