/**
 * Pure math shared by the recommendation readers and services. Lives in `utils/`
 * because repositories (the leaf layer) and services both build feature keys.
 */
/**
 * `credit` is any crew credit. Providers name jobs freely (TMDB "Director", a
 * MAL role, a sidecar `<role>`, any language), so no job name is assumed: the
 * census measures how much each job says about a title (`roleWeights`).
 */
export type RecommendationFeatureKind = "genre" | "keyword" | "cast" | "credit" | "collection";

export interface RecommendationFeatureRef {
	kind: RecommendationFeatureKind;
	id: string;
}

/** One feature row as read from the catalog, before IDF weighting. */
export interface RecommendationFeatureRow extends RecommendationFeatureRef {
	metadataId: string;
	label: string | null;
	/** The provider's job name for a `credit`; null for every other kind. */
	role?: string | null | undefined;
}

export interface RecommendationFeatureStats {
	totalTitles: number;
	documentFrequency: ReadonlyMap<string, number>;
	globalMeanRating: number;
	/** Keyword -> 0..1 genre concentration, keyed by `recommendationFeatureKey("keyword", id)`. */
	keywordConcentration?: ReadonlyMap<string, number>;
	/** Crew job -> 0..1 weight, for the jobs at or above `RECOMMENDATION_CREDIT_MIN_ROLE_WEIGHT`. */
	roleWeights?: ReadonlyMap<string, number>;
}

export interface RecommendationVector {
	weights: Map<string, number>;
	norm: number;
}

/** Upper bound on IDF: an obscure one-off feature must not erase every other signal. */
export const MAX_RECOMMENDATION_IDF = 8;

/**
 * Jobs below this weight are left out. In a TMDB catalog this keeps one-per-title
 * heads of department (director 0.92, cinematographer 0.87, composer 0.77,
 * screenplay 0.32) and drops crowded or rare jobs (executive producer 0.2,
 * stunts 0.04, a unit publicist on a sixth of the titles).
 */
export const RECOMMENDATION_CREDIT_MIN_ROLE_WEIGHT = 0.25;

/**
 * How much one crew job says about a title, from the catalog alone: the share
 * of titles of a type that credit the job, divided by how many people a title
 * credits in it. A job every title has once scores near 1; a job only some
 * titles have, or one shared by a crowd, scores near 0. Works for any provider
 * and any language because the job name is never read.
 */
export function crewRoleWeight(titlesWithJob: number, typeTitles: number, credits: number): number {
	if (titlesWithJob <= 0 || typeTitles <= 0 || credits <= 0) return 0;

	const coverage = titlesWithJob / typeTitles;
	const creditsPerTitle = credits / titlesWithJob;

	return Math.min(1, coverage / creditsPerTitle);
}

/** Release year from an ISO date, or null when the date is missing or implausible. */
export function releaseYear(releaseDate: string): number | null {
	const year = Number.parseInt(releaseDate.slice(0, 4), 10);

	return Number.isFinite(year) && year > 1800 ? year : null;
}

export function recommendationFeatureKey(kind: RecommendationFeatureKind, id: string): string {
	return `${kind}\u0000${id}`;
}

/**
 * Scale-free specificity: how much of the catalog a feature fails to cover.
 * `idf / ln(1 + N)` is 1 for a unique feature and near 0 for one present
 * everywhere, so the same threshold works for a 50-title anime library and a
 * 50,000-title movie library. No provider or language assumptions.
 */
export function recommendationFeatureSpecificity(idf: number, totalTitles: number): number {
	if (totalTitles <= 0) return 0;

	return idf / Math.log(1 + totalTitles);
}

/**
 * Smoothed inverse document frequency. Always positive, so a feature never
 * becomes a negative signal just because it appears in most of the catalog.
 */
export function inverseDocumentFrequency(totalTitles: number, documentFrequency: number): number {
	if (totalTitles <= 0) return 0;

	const safeFrequency = Math.max(0, documentFrequency);

	return Math.min(MAX_RECOMMENDATION_IDF, Math.log(1 + totalTitles / (1 + safeFrequency)));
}

/** L2-normalizes a sparse weight map so a title with many features cannot outscore a focused one. */
export function normalizeRecommendationVector(weights: ReadonlyMap<string, number>): RecommendationVector {
	let sumSquares = 0;
	for (const weight of weights.values()) sumSquares += weight * weight;

	const norm = Math.sqrt(sumSquares);
	if (norm === 0) return { weights: new Map(), norm: 0 };

	const normalized = new Map<string, number>();
	for (const [key, weight] of weights) normalized.set(key, weight / norm);

	return { weights: normalized, norm: 1 };
}

/** Cosine similarity of two L2-normalized sparse vectors. */
export function cosineSimilarity(left: RecommendationVector, right: RecommendationVector): number {
	if (left.norm === 0 || right.norm === 0) return 0;

	const [small, large] = left.weights.size <= right.weights.size ? [left, right] : [right, left];
	let dot = 0;
	for (const [key, weight] of small.weights) {
		const other = large.weights.get(key);
		if (other !== undefined) dot += weight * other;
	}

	return dot / (left.norm * right.norm);
}

/**
 * How narrowly a keyword is confined to genres, on 0..1. A keyword spread
 * evenly over many genres scores 0; one used in a single genre scores 1.
 * Both the entropy and its maximum use the observed genre count, so no genre
 * name, provider taxonomy or language is assumed.
 */
export function keywordGenreConcentration(genreCounts: ReadonlyMap<string, number>): number {
	let total = 0;
	for (const count of genreCounts.values()) total += count;
	if (genreCounts.size <= 1 || total <= 0) return 1;

	let entropy = 0;
	for (const count of genreCounts.values()) {
		const share = count / total;
		if (share > 0) entropy -= share * Math.log(share);
	}

	const maxEntropy = Math.log(genreCounts.size);
	return Math.max(0, Math.min(1, 1 - entropy / maxEntropy));
}
