import type { MetadataWithRelation } from "@sdk";
import { metadataRepository } from "@/database/repositories/metadata.repository";
import { DAY } from "@/server.constants";
import { toMap } from "@/utils/array.utils";

/** Recency decay half-life in days: a seed from 130 days ago has ~50% weight. */
export const RECENCY_HALF_LIFE_DAYS = 130;

/** Trending window: how many days back to count server-wide play activity. */
export const TRENDING_DAYS = 14;

/** Max candidates fetched from the server for global trending. */
export const TRENDING_CANDIDATE_LIMIT = 100;

/**
 * Maximum fraction of the result set that can share the same primary genre.
 * At limit=10 → max 3 items per genre.
 */
export const DIVERSITY_MAX_FRACTION = 1 / 3;

/** Explicit rating bonuses (rating column: 2=like, 1=neutral, 0=dislike). */
export const RATING_WEIGHTS = { like: 6, neutral: 0, dislike: -8 } as const;

/** Bonus for watchlist items, before recency decay. */
export const WATCHLIST_BASE_BONUS = 4;

/** watch_history watchCount multiplier. */
export const WATCH_COUNT_MULTIPLIER = 2;

/**
 * Playback completion bonuses.
 * Completion ratio < 0.2 is a mild negative signal (abandoned early).
 */
export const COMPLETION_BONUS = {
	completed: 8,
	high: 6, // ratio >= 0.8
	mid: 3, // ratio >= 0.5
	low: 0, // ratio < 0.5
	abandoned: -3, // ratio < 0.2 — started and quit early
} as const;

/** Relative weights of genre / keyword / cast in the candidate score. */
export const SIGNAL_WEIGHTS = { genre: 1.0, keyword: 0.5, cast: 0.7 } as const;

/** Popularity contribution to score — intentionally small to avoid popularity bias. */
export const POPULARITY_WEIGHT = 0.03;

export interface ProgressSignal {
	bestCompletionRatio: number;
	anyCompleted: boolean;
	lastEngagedAt: number;
}

/**
 * Exponential recency decay. Returns 1.0 for "just now", ~0.5 at half-life, 0.2 floor.
 * `timestampMs` should be milliseconds since epoch (or 0 → minimum weight).
 */
export function recencyMultiplier(timestampMs: number): number {
	const daysSince = (Date.now() - timestampMs) / DAY;

	return Math.max(0.2, Math.exp((-daysSince * Math.LN2) / RECENCY_HALF_LIFE_DAYS));
}

/**
 * Completion bonus from playback_progress signals.
 * Returns 0 if no progress data exists for this metadata.
 */
export function completionBonus(
	progressMap: Map<string, ProgressSignal>,
	metadataId: string,
): (typeof COMPLETION_BONUS)[keyof typeof COMPLETION_BONUS] {
	const p = progressMap.get(metadataId);
	if (!p) return 0;

	if (p.anyCompleted) return COMPLETION_BONUS.completed;

	if (p.bestCompletionRatio >= 0.8) return COMPLETION_BONUS.high;

	if (p.bestCompletionRatio >= 0.5) return COMPLETION_BONUS.mid;

	if (p.bestCompletionRatio < 0.2 && p.bestCompletionRatio > 0) return COMPLETION_BONUS.abandoned;

	return COMPLETION_BONUS.low;
}

/**
 * Returns the timestamp (ms) to use for recency decay for a given seed item.
 * Prefers playback_progress.updatedAt (last engaged), falls back to 0 (minimum weight).
 */
export function seedTimestamp(progressMap: Map<string, ProgressSignal>, metadataId: string): number {
	const p = progressMap.get(metadataId);

	// lastEngagedAt is unix seconds from SQLite unixepoch()
	return p ? p.lastEngagedAt * 1000 : 0;
}

/**
 * Accumulate per-relation scores from a flat metadataId→relId map, weighted by seed weights.
 * Returns a Map<relId, score>.
 */
export function buildRelationScores(
	byMetadata: Map<string, string[]>,
	seedWeights: Map<string, number>,
	weight: number,
): Map<string, number> {
	const scores = new Map<string, number>();
	for (const [metadataId, w] of seedWeights) {
		for (const relId of byMetadata.get(metadataId) ?? []) {
			const prev = scores.get(relId) ?? 0;
			scores.set(relId, prev + w * weight);
		}
	}

	return scores;
}

/**
 * Score a single candidate against pre-built relation score maps.
 * genreIds / keywordIds / castIds are the relations belonging to that candidate.
 */
export function scoreCandidate(
	genreIds: string[],
	keywordIds: string[],
	castIds: string[],
	popularity: number,
	genreScores: Map<string, number>,
	keywordScores: Map<string, number>,
	castScores: Map<string, number>,
): number {
	const gScore = genreIds.reduce((acc, id) => acc + (genreScores.get(id) ?? 0), 0);
	const kScore = keywordIds.reduce((acc, id) => acc + (keywordScores.get(id) ?? 0), 0);
	const cScore = castIds.reduce((acc, id) => acc + (castScores.get(id) ?? 0), 0);

	return gScore * SIGNAL_WEIGHTS.genre + kScore * SIGNAL_WEIGHTS.keyword + cScore * SIGNAL_WEIGHTS.cast + popularity * POPULARITY_WEIGHT;
}

/**
 * Greedy diversity filter: ensures no single primary genre fills more than
 * `maxPerGenre` slots in the output.
 */
export function applyDiversityFilter<T extends { id: string }>(
	ranked: T[],
	primaryGenreOf: Map<string, string | undefined>,
	limit: number,
): T[] {
	const maxPerGenre = Math.max(2, Math.floor(limit * DIVERSITY_MAX_FRACTION));
	const genreCount = new Map<string, number>();
	const result: T[] = [];

	for (const item of ranked) {
		if (result.length >= limit) break;

		const genre = primaryGenreOf.get(item.id);
		if (genre) {
			const current = genreCount.get(genre) ?? 0;
			if (current >= maxPerGenre) continue;

			genreCount.set(genre, current + 1);
		}

		result.push(item);
	}

	// If diversity filter left us short (e.g. catalogue is dominated by one genre),
	// fill remaining slots from ranked items not yet included.
	if (result.length < limit) {
		const included = new Set(result.map((i) => i.id));
		for (const item of ranked) {
			if (result.length >= limit) break;

			if (!included.has(item.id)) result.push(item);
		}
	}

	return result;
}

export interface CandidateItem {
	id: string;
	popularity?: number | null;
	createdAt?: Date | null;
}

/**
 * Cold-start fallback for profiles with no watch/rating/watchlist history.
 * Returns a blend: 60% most popular + 40% most recently added, deduplicated.
 */
export function coldStartFallback<T extends CandidateItem>(candidates: T[], limit: number): T[] {
	const byPopularity = candidates.toSorted((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0));
	const byRecency = candidates.toSorted((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));

	const newCount = Math.ceil(limit * 0.4);
	const popularCount = limit - newCount;

	const seen = new Set<string>();
	const result: T[] = [];

	for (const item of byPopularity.slice(0, popularCount * 2)) {
		if (result.length >= popularCount) break;

		if (item.id && !seen.has(item.id)) {
			seen.add(item.id);
			result.push(item);
		}
	}

	for (const item of byRecency) {
		if (result.length >= limit) break;

		if (item.id && !seen.has(item.id)) {
			seen.add(item.id);
			result.push(item);
		}
	}

	return result;
}

/**
 * Trending = items with high server-wide play activity in the last TRENDING_DAYS days,
 * scored as: playCount (normalised) × 0.6 + popularity (normalised) × 0.4.
 * Falls back to popularity-sorted recentlyAdded if server has no watch data yet.
 */
export async function buildTrending(
	activityRows: Array<{ metadataId: string | null; playCount: number }>,
	recentlyAdded: MetadataWithRelation[],
	limit: number,
	knownMap: Map<string, MetadataWithRelation>,
): Promise<MetadataWithRelation[]> {
	const validActivity = activityRows.filter((r): r is { metadataId: string; playCount: number } => Boolean(r.metadataId));

	if (validActivity.length === 0) {
		// Cold start: no server-wide activity yet — popularity-sorted recentlyAdded.
		return [...recentlyAdded].toSorted((a, b) => b.popularity - a.popularity).slice(0, limit);
	}

	// Find max values for normalisation (avoid division by zero).
	let maxPlayCount = 0;
	let maxPopularity = 0;
	for (const row of validActivity) {
		if (row.playCount > maxPlayCount) maxPlayCount = row.playCount;

		const pop = knownMap.get(row.metadataId)?.popularity ?? 0;
		if (pop > maxPopularity) maxPopularity = pop;
	}

	// Gather all metadata for trending candidates (may need extra DB fetch).
	const trendingIds = validActivity.map((r) => r.metadataId);
	const missingIds = trendingIds.filter((id) => !knownMap.has(id));
	if (missingIds.length > 0) {
		const fetched = await metadataRepository.findManyByIdsWithRelations(missingIds).catch(() => []);
		for (const m of fetched) knownMap.set(m.id, m);
	}

	const activityByMetadataId = toMap(
		validActivity,
		(r) => r.metadataId,
		(r) => r.playCount,
	);

	const scored: Array<{ item: MetadataWithRelation; score: number }> = [];
	for (const id of trendingIds) {
		const item = knownMap.get(id);
		if (!item) continue;

		const normPlay = maxPlayCount > 0 ? (activityByMetadataId.get(id) ?? 0) / maxPlayCount : 0;
		const normPop = maxPopularity > 0 ? item.popularity / maxPopularity : 0;
		scored.push({ item, score: normPlay * 0.6 + normPop * 0.4 });
	}

	scored.sort((a, b) => b.score - a.score);

	return scored.slice(0, limit).map((entry) => entry.item);
}
