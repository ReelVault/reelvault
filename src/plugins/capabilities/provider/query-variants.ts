import type { MatchCandidate } from "@/utils/media-match.utils";
import { generateQueryVariants, pickBestMatch } from "@/utils/media-match.utils";

export type SearchCandidate = MatchCandidate & { externalId: string };

/**
 * Queries a provider with several phrasings of the title (see generateQueryVariants) and merges
 * the results by externalId, stopping early once a confident match is already found so ambiguous
 * titles get the extra lookups while clear-cut ones don't pay for them.
 */
export async function searchWithVariants<T extends SearchCandidate>(
	searchOne: (query: string) => Promise<T[] | null | undefined>,
	title: string,
	year: number | undefined,
): Promise<T[]> {
	const merged = new Map<string, T>();
	for (const variant of generateQueryVariants(title)) {
		const results = await searchOne(variant);
		for (const result of results ?? []) {
			if (!merged.has(result.externalId)) merged.set(result.externalId, result);
		}

		const candidates = [...merged.values()];
		const best = pickBestMatch(candidates, title, year);
		if (best && best.score >= 0.88) break;
	}

	return [...merged.values()];
}
