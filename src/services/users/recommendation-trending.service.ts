import type { MetadataWithRelation } from "@reelvault/sdk";
import { metadataRepository } from "@/repositories/metadata.repository";
import { toMap } from "@/utils/array.utils";
import { createLogger } from "@/utils/logger.utils";

const logger = createLogger("RecommendationTrending");

/** Trending window: how many days back to count server-wide play activity. */
export const TRENDING_DAYS = 14;

/** Max candidates fetched from the server for global trending. */
export const TRENDING_CANDIDATE_LIMIT = 100;

/**
 * Trending = items with high server-wide play activity in the last
 * `TRENDING_DAYS` days, scored as playCount (normalised) × 0.6 + popularity
 * (normalised) × 0.4. Falls back to popularity-sorted recentlyAdded when the
 * server has no watch data yet. Viewer-independent by design: recommendations
 * are profile-scoped, trending is the "what is hot here" row.
 */
export async function buildTrending(
	activityRows: Array<{ metadataId: string | null; playCount: number }>,
	recentlyAdded: MetadataWithRelation[],
	limit: number,
	knownMap: Map<string, MetadataWithRelation>,
): Promise<MetadataWithRelation[]> {
	const validActivity = activityRows.filter((row): row is { metadataId: string; playCount: number } => Boolean(row.metadataId));

	if (validActivity.length === 0) {
		return recentlyAdded.toSorted((a, b) => b.popularity - a.popularity).slice(0, limit);
	}

	const trendingIds = validActivity.map((row) => row.metadataId);
	const missingIds = trendingIds.filter((id) => !knownMap.has(id));
	if (missingIds.length > 0) {
		const fetched = await metadataRepository.findManyByIdsWithRelations(missingIds).catch((error: unknown) => {
			logger.warn("Failed to load trending titles missing from the catalog batch", { count: missingIds.length, err: error });

			return [];
		});
		for (const metadata of fetched) knownMap.set(metadata.id, metadata);
	}

	let maxPlayCount = 0;
	let maxPopularity = 0;
	for (const row of validActivity) {
		if (row.playCount > maxPlayCount) maxPlayCount = row.playCount;

		const popularity = knownMap.get(row.metadataId)?.popularity ?? 0;
		if (popularity > maxPopularity) maxPopularity = popularity;
	}

	const activityByMetadataId = toMap(
		validActivity,
		(row) => row.metadataId,
		(row) => row.playCount,
	);
	const scored: Array<{ item: MetadataWithRelation; score: number }> = [];

	for (const id of trendingIds) {
		const item = knownMap.get(id);
		if (!item) continue;

		const normalizedPlay = maxPlayCount > 0 ? (activityByMetadataId.get(id) ?? 0) / maxPlayCount : 0;
		const normalizedPopularity = maxPopularity > 0 ? item.popularity / maxPopularity : 0;
		scored.push({ item, score: normalizedPlay * 0.6 + normalizedPopularity * 0.4 });
	}

	scored.sort((left, right) => right.score - left.score);

	return scored.slice(0, limit).map((entry) => entry.item);
}
