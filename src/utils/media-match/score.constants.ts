import { MemoryCache } from "@/utils/memory.cache";
import { bigramDice, writeBigramCodes } from "./bigram.utils";
import { extractYear, normalizeTitle, splitToSet } from "./normalize.utils";
import { extractSequelNumber, sequelMismatch } from "./sequel.utils";

/**
 * Fuzzy matching between a locally parsed title/year and candidates returned by a metadata provider
 * (e.g. TMDB). Used to pick the correct search result instead of blindly trusting result order,
 * since providers rank by popularity, not by relevance to the query.
 */

export interface MatchCandidate {
	title: string;
	originalTitle?: string | undefined;
	originalLanguage?: string | undefined;
	releaseDate?: string | undefined;
	popularity?: number | undefined;
	voteCount?: number | undefined;
}

export interface ScoredCandidate<T extends MatchCandidate> {
	item: T;
	score: number;
	titleScore: number;
	yearScore: number;
	popularityScore: number;
}

/** Score a match is reviewed below in the admin lists (low confidence, title mismatch audit). Not an acceptance threshold. */
export const REVIEW_MATCH_SCORE = 0.75;

/** Score above which a candidate is accepted outright, even without a clear margin over the runner-up. */
export const CONFIDENT_MATCH_SCORE = 0.7;

/** When the best candidate is below CONFIDENT_MATCH_SCORE, it still needs to beat the runner-up by this much to be trusted. */
export const MIN_SCORE_MARGIN = 0.15;

const BIGRAM_TITLE_WEIGHT = 0.6;
const TOKEN_TITLE_WEIGHT = 0.4;

const TITLE_SCORE_WEIGHT = 0.58;
const YEAR_SCORE_WEIGHT = 0.3;
const POPULARITY_SCORE_WEIGHT = 0.12;

/** The expected side of a title comparison, prepared once per candidate list. */
interface PreparedTitle {
	norm: string;
	bigramCodes: number[];
	tokens: Set<string>;
	/** Sequel number extracted once per normalized title (regex is not per-comparison). */
	sequel: string | null;
}

function prepareTitle(norm: string): PreparedTitle {
	const bigramCodes: number[] = [];
	writeBigramCodes(norm, bigramCodes);

	return { norm, bigramCodes, tokens: splitToSet(norm), sequel: extractSequelNumber(norm) };
}

// Bounded cache keyed by the raw title: a hit skips normalization *and* bigram/
// token rebuilding. Provider results repeat heavily across searches.
const preparedTitleCache = new MemoryCache<PreparedTitle>({ ttlMs: -1, maxSize: 2048, name: "prepared-title" });

/** The title prepared for comparison, from the cache when the raw title was seen before. */
export function prepareTitleCached(rawTitle: string): PreparedTitle {
	const cached = preparedTitleCache.get(rawTitle);
	if (cached !== null) return cached;

	const prepared = prepareTitle(normalizeTitle(rawTitle));
	preparedTitleCache.set(rawTitle, prepared);

	return prepared;
}

/** Scores one candidate against the prepared query title and the year being looked for. */
export function scoreCandidate<T extends MatchCandidate>(query: PreparedTitle, item: T, year: number | undefined): ScoredCandidate<T> {
	const titleScore = candidateTitleScore(query, item);
	const yearScore = scoreYearMatch(year, extractYear(item.releaseDate));
	const popularityScore = scorePopularity(item.popularity, item.voteCount);
	const languageBonus = item.originalLanguage === "en" || item.originalLanguage === "pl" ? 0.02 : 0;
	const score = titleScore * TITLE_SCORE_WEIGHT + yearScore * YEAR_SCORE_WEIGHT + popularityScore * POPULARITY_SCORE_WEIGHT + languageBonus;

	return { item, titleScore, yearScore, popularityScore, score };
}

/**
 * Determines whether the recognized title has a sequel mismatch with the candidate.
 * If either the localized title OR the original title is sequel-compatible and matches well,
 * it is not considered a sequel mismatch (e.g. "The Fate of the Furious" vs a localized title
 * where originalTitle is "The Fate of the Furious").
 */
export function isSequelMismatch(recognizedTitle: string, candidate: { title: string; originalTitle?: string | null }): boolean {
	const normRecognized = normalizeTitle(recognizedTitle);
	const normTitle = normalizeTitle(candidate.title);
	const normOriginal = candidate.originalTitle ? normalizeTitle(candidate.originalTitle) : "";

	const mismatchWithTitle = hasSequelMismatch(normRecognized, normTitle);
	if (!mismatchWithTitle) return false;

	// If localized title had a sequel mismatch, check if originalTitle is compatible and clean
	if (normOriginal) {
		const mismatchWithOriginal = hasSequelMismatch(normRecognized, normOriginal);
		if (!mismatchWithOriginal && compositeTitleScore(prepareTitle(normRecognized), candidate.originalTitle ?? "") >= 0.65) {
			return false;
		}
	}

	return true;
}

function hasSequelMismatch(aNorm: string, bNorm: string): boolean {
	return sequelMismatch(extractSequelNumber(aNorm), extractSequelNumber(bNorm));
}

/** Evaluates candidate title score against both localized title and originalTitle, taking the maximum. */
function candidateTitleScore(expected: PreparedTitle, candidate: MatchCandidate): number {
	const localizedScore = compositeTitleScore(expected, candidate.title);
	if (!candidate.originalTitle || candidate.originalTitle.trim() === candidate.title.trim()) {
		return localizedScore;
	}

	const originalScore = compositeTitleScore(expected, candidate.originalTitle);

	return Math.max(localizedScore, originalScore);
}

/** Blends bigram similarity (typo-tolerant) with token overlap (word-order-tolerant) into a single 0..1 title score. */
function compositeTitleScore(expected: PreparedTitle, b: string): number {
	const candidate = prepareTitleCached(b);
	if (expected.norm === candidate.norm) return 1.0;

	let rawScore = titleSimilarity(expected, candidate) * BIGRAM_TITLE_WEIGHT + tokenOverlap(expected, candidate) * TOKEN_TITLE_WEIGHT;

	// Penalize sequel mismatches (e.g. Iron Man vs Iron Man 3) so they cannot match confidently
	if (sequelMismatch(expected.sequel, candidate.sequel)) {
		rawScore *= 0.35;
	}

	return rawScore;
}

/** Bigram Dice similarity of two titles, tolerant of small formatting differences ("Vol. 2" vs "Volume 2"). */
function titleSimilarity(expected: PreparedTitle, candidate: PreparedTitle): number {
	if (!(expected.norm && candidate.norm)) return 0;

	return bigramDice(expected.bigramCodes, candidate.bigramCodes);
}

/** Dice coefficient over normalized word tokens, returns 0..1. Catches matches bigrams miss on short or reordered titles. */
function tokenOverlap(expected: PreparedTitle, candidate: PreparedTitle): number {
	const tokensA = expected.tokens;
	const tokensB = candidate.tokens;
	if (tokensA.size === 0 || tokensB.size === 0) return 0;

	let intersectionSize = 0;
	for (const token of tokensA) {
		if (tokensB.has(token)) intersectionSize++;
	}

	return (2 * intersectionSize) / (tokensA.size + tokensB.size);
}

/** Penalizes candidates whose year is off; an unknown year on either side is neutral rather than disqualifying. */
function scoreYearMatch(expectedYear: number | undefined, candidateYear: number | undefined) {
	if (!(expectedYear && candidateYear)) return 0.5;

	const diff = Math.abs(expectedYear - candidateYear);
	if (diff === 0) return 1;

	if (diff === 1) return 0.8;

	if (diff === 2) return 0.2;

	return 0;
}

/**
 * Continuous logarithmic popularity and vote score scaling.
 * Gives significant weight to high-vote blockbusters while fairly scoring smaller releases.
 */
function scorePopularity(popularity: number | undefined, voteCount: number | undefined): number {
	const voteScore = voteCount && voteCount > 0 ? Math.min(1, Math.log10(1 + voteCount) / 5) : 0;
	const popScore = popularity && popularity > 0 ? Math.min(1, Math.log10(1 + popularity) / 3) : 0;

	return voteScore * 0.65 + popScore * 0.35;
}
