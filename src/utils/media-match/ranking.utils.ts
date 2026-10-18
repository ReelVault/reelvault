import {
	CONFIDENT_MATCH_SCORE,
	type MatchCandidate,
	MIN_SCORE_MARGIN,
	prepareTitleCached,
	type ScoredCandidate,
	scoreCandidate,
} from "./score.constants";

/** Ranks candidates against the title/year we're looking for, best first. */
export function rankCandidates<T extends MatchCandidate>(
	candidates: readonly T[],
	title: string,
	year: number | undefined,
): Array<ScoredCandidate<T>> {
	const query = prepareTitleCached(title);

	return candidates.map((item) => scoreCandidate(query, item, year)).toSorted(compareScored);
}

/** Ranking order: score desc (with a 0.005 tie epsilon), then votes desc, then popularity desc. */
function compareScored<T extends MatchCandidate>(left: ScoredCandidate<T>, right: ScoredCandidate<T>): number {
	const diff = right.score - left.score;
	if (Math.abs(diff) > 0.005) return diff;

	const votesLeft = left.item.voteCount ?? 0;
	const votesRight = right.item.voteCount ?? 0;
	if (votesLeft !== votesRight) return votesRight - votesLeft;

	return (right.item.popularity ?? 0) - (left.item.popularity ?? 0);
}

/**
 * A best candidate is accepted when it reaches `minScore` (the `metadata.minMatchScore` setting) and either
 * clears CONFIDENT_MATCH_SCORE outright or leads the runner-up by at least MIN_SCORE_MARGIN.
 */
export function isAcceptableMatch(best: { score: number }, runnerUp: { score: number } | undefined, minScore: number): boolean {
	if (best.score < minScore) return false;
	if (best.score >= CONFIDENT_MATCH_SCORE) return true;

	return !runnerUp || best.score - runnerUp.score >= MIN_SCORE_MARGIN;
}

/**
 * Picks the best-scoring candidate. Accepted when `isAcceptableMatch` says so. Otherwise the match is too
 * ambiguous to trust and undefined is returned.
 */
export function pickBestMatch<T extends MatchCandidate>(
	candidates: readonly T[],
	title: string,
	year: number | undefined,
	minScore: number,
): ScoredCandidate<T> | undefined {
	const query = prepareTitleCached(title);

	// Single pass for best + runner-up (O(n)); `rankCandidates` keeps the full sort
	// for callers that need the whole order.
	let best: ScoredCandidate<T> | undefined;
	let runnerUp: ScoredCandidate<T> | undefined;
	for (const item of candidates) {
		const scored = scoreCandidate(query, item, year);
		if (!best || compareScored(scored, best) < 0) {
			runnerUp = best;
			best = scored;
		} else if (!runnerUp || compareScored(scored, runnerUp) < 0) {
			runnerUp = scored;
		}
	}

	if (!best) return undefined;

	return isAcceptableMatch(best, runnerUp, minScore) ? best : undefined;
}
