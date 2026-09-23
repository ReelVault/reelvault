import { unique } from "./array.utils";
import { MemoryCache } from "./memory-cache";

const DIACRITICS_PATTERN = /\p{M}/gu;

/** Strips Unicode combining marks (diacritics) from a string after NFD decomposition. */
export function stripDiacritics(value: string): string {
	return value.normalize("NFD").replace(DIACRITICS_PATTERN, "");
}

const WORD_SPLIT_PATTERN = /\s+/;
const STROKE_LETTER_REGEX = /[łŁđĐøØ]/g;
// NFD decomposition misses stroke letters (ł, Ł, đ, ø) — they have no
// combining-mark form and must be mapped explicitly.
const STROKE_LETTER_MAP: Record<string, string> = { ł: "l", Ł: "l", đ: "d", Đ: "d", ø: "o", Ø: "o" };
const WHITESPACE_COLLAPSE = /\s+/g;
const PUNCTUATION_COLLAPSE = /[.:_]+|\s+/g;
const TITLE_PUNCTUATION = /[.'".,:()[\]\-_/]+/g;

/** Lowercases and strips diacritics, mirroring the FTS5 `remove_diacritics 2` tokenizer. */
export function normalizeForFuzzy(value: string): string {
	const unstroked = value.replace(STROKE_LETTER_REGEX, (character) => STROKE_LETTER_MAP[character] ?? character);

	return stripDiacritics(unstroked.toLowerCase());
}

/**
 * Levenshtein distance with a banded early exit: returns `null` as soon as the
 * distance provably exceeds `maxDistance`, so a scan over many candidates pays
 * (at most) a thin diagonal band of the matrix per row.
 */
export function boundedLevenshtein(source: string, target: string, maxDistance: number): number | null {
	if (source === target) return 0;

	if (Math.abs(source.length - target.length) > maxDistance) return null;

	// Ensure target is the shorter string to minimize row memory and inner loop iterations.
	const s = source.length >= target.length ? source : target;
	const t = source.length >= target.length ? target : source;
	const sLen = s.length;
	const tLen = t.length;

	let v0: number[] = Array.from({ length: tLen + 1 });
	let v1: number[] = Array.from({ length: tLen + 1 });
	for (let j = 0; j <= tLen; j++) {
		v0[j] = j;
	}

	for (let i = 1; i <= sLen; i++) {
		v1[0] = i;
		let rowMinimum = i;
		const sCharCode = s.charCodeAt(i - 1);

		for (let j = 1; j <= tLen; j++) {
			const substitution = (v0[j - 1] ?? 0) + (sCharCode === t.charCodeAt(j - 1) ? 0 : 1);
			const value = Math.min((v0[j] ?? 0) + 1, (v1[j - 1] ?? 0) + 1, substitution);
			v1[j] = value;
			if (value < rowMinimum) rowMinimum = value;
		}

		if (rowMinimum > maxDistance) return null;

		const temp = v0;
		v0 = v1;
		v1 = temp;
	}

	const distance = v0[tLen];

	return distance !== undefined && distance <= maxDistance ? distance : null;
}

/**
 * Best distance between the (single) query token and any word of the title.
 * `null` means the title cannot match within the accepted distance.
 */
export function fuzzyTitleDistance(queryToken: string, title: string, maxDistance: number): number | null {
	const query = normalizeForFuzzy(queryToken);
	if (!query) return null;

	const words = normalizeForFuzzy(title).split(WORD_SPLIT_PATTERN).filter(Boolean);
	let best: number | null = null;
	for (const word of words) {
		if (word === query) return 0;

		// Contained words (prefix-stemmed queries, "war" in "Warsaw") are near
		// hits priced by the length gap — but only while within the threshold.
		if (word.includes(query) || query.includes(word)) {
			const gap = Math.abs(word.length - query.length);
			if (gap <= maxDistance && (best === null || gap < best)) best = gap;

			continue;
		}

		const distance = boundedLevenshtein(query, word, maxDistance);
		if (distance !== null && (best === null || distance < best)) best = distance;
	}

	return best;
}

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

/** Minimum combined score required to accept a search result as a confident match at all. Below this, treat it as "not found". */
export const MIN_MATCH_SCORE = 0.45;

/** Score above which a candidate is accepted outright, even without a clear margin over the runner-up. */
export const CONFIDENT_MATCH_SCORE = 0.7;

/** When the best candidate is below CONFIDENT_MATCH_SCORE, it still needs to beat the runner-up by this much to be trusted. */
export const MIN_SCORE_MARGIN = 0.15;

const BIGRAM_TITLE_WEIGHT = 0.6;
const TOKEN_TITLE_WEIGHT = 0.4;

const TITLE_SCORE_WEIGHT = 0.58;
const YEAR_SCORE_WEIGHT = 0.3;
const POPULARITY_SCORE_WEIGHT = 0.12;

const EDITION_NOISE =
	/\b(?:directors?\s+cut|extended(?:\s+cut|\s+edition)?|theatrical(?:\s+cut|\s+version)?|unrated(?:\s+cut|\s+version)?|remastered|imax(?:\s+edition)?|special\s+edition|final\s+cut|ultimate\s+cut)\b/gi;
const LEADING_THE = /^the\s+/i;
const AND_WORD_GLOBAL = /\band\b/gi;

const ROMAN_NUMERALS: Record<string, string> = {
	i: "1",
	ii: "2",
	iii: "3",
	iv: "4",
	v: "5",
	vi: "6",
	vii: "7",
	viii: "8",
	ix: "9",
	x: "10",
};

const SEQUEL_DIGIT_PATTERN = /\b(?:part|pt|vol|volume|chapter|czesc|faza)?\s*([1-9]|1[0-9]|20)\b$/i;

/**
 * Extracts a normalized sequel number from the end of a title (e.g. "iron man 3" -> "3", "dune part 2" -> "2").
 */
function extractSequelNumber(normalizedTitle: string): string | null {
	return normalizedTitle.match(SEQUEL_DIGIT_PATTERN)?.[1] ?? null;
}

/**
 * Detects whether there is a mismatch in sequel numbers between query and candidate.
 * e.g. "Iron Man" (no sequel) vs "Iron Man 3" (sequel 3) -> true (mismatch!)
 * e.g. "Iron Man 2" vs "Iron Man 3" -> true (mismatch!)
 * e.g. "Iron Man" vs "Iron Man 1" -> false (compatible)
 * e.g. "Iron Man 2" vs "Iron Man 2" -> false (compatible)
 */
function sequelMismatch(sequelA: string | null, sequelB: string | null): boolean {
	if (!(sequelA || sequelB)) return false;

	if (sequelA === sequelB) return false;

	if ((!sequelA && sequelB === "1") || (sequelA === "1" && !sequelB)) return false;

	return true;
}

function hasSequelMismatch(aNorm: string, bNorm: string): boolean {
	return sequelMismatch(extractSequelNumber(aNorm), extractSequelNumber(bNorm));
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

/**
 * Generates alternate phrasings of a title so a provider search that misses on the raw string
 * still has a chance to surface the right candidate (different punctuation, "&" vs "and", "The" prefix).
 */
export function generateQueryVariants(title: string): string[] {
	const trimmed = title.trim();
	const withoutEdition = trimmed.replace(EDITION_NOISE, "").replace(WHITESPACE_COLLAPSE, " ").trim();
	const withoutPunctuation = trimmed.replace(PUNCTUATION_COLLAPSE, " ").trim();
	const withoutLeadingThe = withoutPunctuation.replace(LEADING_THE, "");
	const swappedAmpersand = trimmed.includes("&") ? trimmed.replaceAll("&", "and") : trimmed.replace(AND_WORD_GLOBAL, "&");

	return unique([trimmed, withoutEdition, withoutPunctuation, withoutLeadingThe, swappedAmpersand].filter(Boolean));
}

/** Ranks candidates against the title/year we're looking for, best first. */
export function rankCandidates<T extends MatchCandidate>(
	candidates: readonly T[],
	title: string,
	year: number | undefined,
): Array<ScoredCandidate<T>> {
	const preparedTitle = prepareTitleCached(title);

	return candidates.map((item) => scoreCandidate(preparedTitle, item, year)).toSorted(compareScored);
}

function scoreCandidate<T extends MatchCandidate>(preparedTitle: PreparedTitle, item: T, year: number | undefined): ScoredCandidate<T> {
	const titleScore = candidateTitleScore(preparedTitle, item);
	const yearScore = scoreYearMatch(year, extractYear(item.releaseDate));
	const popularityScore = scorePopularity(item.popularity, item.voteCount);
	const languageBonus = item.originalLanguage === "en" || item.originalLanguage === "pl" ? 0.02 : 0;
	const score = titleScore * TITLE_SCORE_WEIGHT + yearScore * YEAR_SCORE_WEIGHT + popularityScore * POPULARITY_SCORE_WEIGHT + languageBonus;

	return { item, titleScore, yearScore, popularityScore, score };
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
 * Picks the best-scoring candidate. Accepted when either:
 * - its score clears CONFIDENT_MATCH_SCORE outright, or
 * - it clears MIN_MATCH_SCORE and leads the runner-up by at least MIN_SCORE_MARGIN.
 * Otherwise the match is too ambiguous to trust and undefined is returned.
 */
export function pickBestMatch<T extends MatchCandidate>(
	candidates: readonly T[],
	title: string,
	year: number | undefined,
): ScoredCandidate<T> | undefined {
	const preparedTitle = prepareTitleCached(title);

	// Single pass for best + runner-up (O(n)); `rankCandidates` keeps the full sort
	// for callers that need the whole order.
	let best: ScoredCandidate<T> | undefined;
	let runnerUp: ScoredCandidate<T> | undefined;
	for (const item of candidates) {
		const scored = scoreCandidate(preparedTitle, item, year);
		if (!best || compareScored(scored, best) < 0) {
			runnerUp = best;
			best = scored;
		} else if (!runnerUp || compareScored(scored, runnerUp) < 0) {
			runnerUp = scored;
		}
	}

	if (!best) return undefined;

	if (best.score >= CONFIDENT_MATCH_SCORE) return best;

	const hasClearMargin = !runnerUp || best.score - runnerUp.score >= MIN_SCORE_MARGIN;

	return best.score >= MIN_MATCH_SCORE && hasClearMargin ? best : undefined;
}

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

// Reusable open-addressing table for bigram frequencies — synchronous and never
// re-entered, so no Map hashing or per-comparison allocation is needed.
const HASH_LOAD_FACTOR = 4;
let hashCapacity = 256;
let hashKeys = new Int32Array(hashCapacity);
let hashCounts = new Int32Array(hashCapacity);
let hashUsed = new Uint8Array(hashCapacity);

function ensureHashCapacity(needed: number): void {
	if (needed * HASH_LOAD_FACTOR <= hashCapacity) return;

	let capacity = hashCapacity;
	while (capacity < needed * HASH_LOAD_FACTOR) capacity <<= 1;

	hashCapacity = capacity;
	hashKeys = new Int32Array(capacity);
	hashCounts = new Int32Array(capacity);
	hashUsed = new Uint8Array(capacity);
}

function hashCode(code: number, mask: number): number {
	return (Math.imul(code, 2654435761) >>> 0) & mask;
}

// Bounded cache keyed by the raw title: a hit skips normalization *and* bigram/
// token rebuilding. Provider results repeat heavily across searches.
const preparedTitleCache = new MemoryCache<PreparedTitle>({ ttlMs: -1, maxSize: 2048, name: "prepared-title" });

function prepareTitleCached(rawTitle: string): PreparedTitle {
	const cached = preparedTitleCache.get(rawTitle);
	if (cached !== null) return cached;

	const prepared = prepareTitle(normalizeTitle(rawTitle));
	preparedTitleCache.set(rawTitle, prepared);

	return prepared;
}

/** Encodes adjacent non-space code-unit pairs into 32-bit codes, without substring allocation. */
function writeBigramCodes(value: string, out: number[]): void {
	out.length = 0;
	let previous = -1;
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code === 32) continue;

		if (previous >= 0) out.push(previous * 65536 + code);

		previous = code;
	}

	// Mirror the old single-character fallback with a distinct marker code, so two
	// one-character titles still match each other (and neither matches a real bigram).
	if (out.length === 0 && previous >= 0) out.push(-1 - previous);
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

/** Sørensen–Dice coefficient over character bigrams, returns 0..1. Tolerant of small formatting differences ("Vol. 2" vs "Volume 2"). */
function titleSimilarity(expected: PreparedTitle, candidate: PreparedTitle): number {
	if (!(expected.norm && candidate.norm)) return 0;

	if (expected.norm === candidate.norm) return 1;

	const bigramCodesA = expected.bigramCodes;
	const bigramCodesB = candidate.bigramCodes;
	if (bigramCodesA.length === 0 || bigramCodesB.length === 0) return 0;

	ensureHashCapacity(bigramCodesA.length + bigramCodesB.length);
	const mask = hashCapacity - 1;
	hashUsed.fill(0);

	for (const code of bigramCodesB) bigramHashInsert(code, mask);

	let matches = 0;
	for (const code of bigramCodesA) if (bigramHashConsume(code, mask)) matches += 1;

	return (2 * matches) / (bigramCodesA.length + bigramCodesB.length);
}

function bigramHashInsert(code: number, mask: number): void {
	let index = hashCode(code, mask);
	for (;;) {
		if ((hashUsed[index] ?? 0) === 0) {
			hashUsed[index] = 1;
			hashKeys[index] = code;
			hashCounts[index] = 1;

			return;
		}

		if ((hashKeys[index] ?? 0) === code) {
			hashCounts[index] = (hashCounts[index] ?? 0) + 1;

			return;
		}

		index = (index + 1) & mask;
	}
}

/** Decrements the stored count when `code` is present with a positive count. */
function bigramHashConsume(code: number, mask: number): boolean {
	let index = hashCode(code, mask);
	for (;;) {
		if ((hashUsed[index] ?? 0) === 0) return false;

		if ((hashKeys[index] ?? 0) === code) {
			const count = hashCounts[index] ?? 0;
			if (count <= 0) return false;

			hashCounts[index] = count - 1;

			return true;
		}

		index = (index + 1) & mask;
	}
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

function splitToSet(value: string): Set<string> {
	const set = new Set<string>();
	let start = 0;
	for (let index = 0; index <= value.length; index++) {
		if (index === value.length || value.charCodeAt(index) === 32) {
			if (index > start) set.add(value.slice(start, index));

			start = index + 1;
		}
	}

	return set;
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

/** Strips diacritics, punctuation, edition tags, a leading "the", and normalizes roman numerals so titles compare fairly across languages/formats. */
const normalizeTitleCache = new MemoryCache<string>({ ttlMs: -1, maxSize: 2048, name: "normalize-title" });
const LEADING_THE_PATTERN = /^the\s+/;

function normalizeTitle(value: string): string {
	const cached = normalizeTitleCache.get(value);
	if (cached !== null) return cached;

	const withoutDiacritics = stripDiacritics(value).toLowerCase();
	const withoutEdition = withoutDiacritics.replace(EDITION_NOISE, " ");
	const withoutPunctuation = withoutEdition.replace(TITLE_PUNCTUATION, " ").replace(WHITESPACE_COLLAPSE, " ").trim();
	const withoutLeadingThe = withoutPunctuation.replace(LEADING_THE_PATTERN, "");
	const normalized = withoutLeadingThe
		.split(" ")
		.map((word) => ROMAN_NUMERALS[word] ?? word)
		.join(" ");

	normalizeTitleCache.set(value, normalized);

	return normalized;
}

function extractYear(date: string | undefined): number | undefined {
	const year = date && date.length >= 4 ? Number(date.slice(0, 4)) : undefined;

	return year && Number.isInteger(year) ? year : undefined;
}
