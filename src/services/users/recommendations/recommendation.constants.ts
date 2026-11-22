import type { RecommendationFeatureKind } from "@/utils/recommendation-feature.utils";

/** Candidate ceiling before scoring. Beyond this, SQLite prepares more rows than the rank can use. */
export const RECOMMENDATION_CANDIDATE_LIMIT = 500;

/** At most this many seeds contribute to the profile; the rest are noise or duplicates. */
export const RECOMMENDATION_MAX_SEEDS = 60;
export const RECOMMENDATION_MAX_NEGATIVE_SEEDS = 20;

/** A content-based slate may be shorter than the requested limit, but never shorter than this. */
export const RECOMMENDATION_MIN_ITEMS = 5;

/** Specific features used to generate candidates. */
export const RECOMMENDATION_TOP_FEATURES_PER_KIND = 10;
export const RECOMMENDATION_TOP_FEATURES = 40;
export const RECOMMENDATION_CANDIDATE_FEATURE_DF_MAX_SHARE = 0.4;

/**
 * A shared feature below this specificity is too common to prove a match on
 * its own. Specificity is `idf / ln(1 + N)`, so the threshold is relative to
 * the catalog and works with any metadata provider, taxonomy or language.
 */
export const RECOMMENDATION_THEME_SPECIFICITY = 0.45;
/** One theme above this floor is evidence enough when the title also resembles a watched one. */
export const RECOMMENDATION_STRONG_SPECIFICITY = 0.7;
/**
 * Resemblance to a watched title is the cosine of theme vectors, whose scale
 * depends on how densely a provider tags titles. The thresholds below are
 * therefore shares of the profile's best resemblance among its candidates,
 * never below this floor, so a profile with only weak matches is judged by
 * fixed values (0.10, 0.067, 0.15).
 */
export const RECOMMENDATION_MIN_SIMILARITY_SCALE = 1 / 3;
/**
 * The resemblance a single strong theme needs. A rare mood tag ("brisk") can be
 * as specific as a real subject ("medical drama"), but a title that shares only
 * the tag looks like none of the watched titles.
 */
export const RECOMMENDATION_STRONG_THEME_SEED_SIMILARITY = 0.2;
/**
 * Without one strong theme, the shared themes' specificities must add up to
 * this: two near-strong themes or three medium ones. Two medium themes are not
 * enough, because broad mood tags ("intimate", "compassionate") pair up on
 * titles that share nothing else with the profile.
 */
export const RECOMMENDATION_MIN_THEME_EVIDENCE = 1.3;
/** One shared theme plus a modest resemblance (as a share of the similarity scale) is enough. */
export const RECOMMENDATION_THEME_SEED_SIMILARITY = 0.3;
/** A resemblance this close (as a share of the similarity scale) qualifies on its own. */
export const RECOMMENDATION_STRONG_SEED_SIMILARITY = 0.45;
/** A seed this weak (a single episode, a stale save) is not taste evidence. */
export const RECOMMENDATION_MIN_SEED_WEIGHT = 0.35;
/** Below this type share, a single theme is not enough evidence. */
export const RECOMMENDATION_MINORITY_TYPE_SHARE = 0.3;
export const RECOMMENDATION_CAST_EVIDENCE_WEIGHT = 0.5;
export const RECOMMENDATION_CAST_EVIDENCE_SCORE = 0.7;

/** Guards against tag/keyword-stuffed provider records. */
export const RECOMMENDATION_MAX_KEYWORDS_PER_TITLE = 24;
export const RECOMMENDATION_MAX_FEATURES_PER_TITLE = 64;

/**
 * Signal weights after IDF. Genres are deliberately the weakest: "Drama" is a
 * container, not a taste. Keywords and creators carry the specific intent.
 */
export const RECOMMENDATION_FEATURE_TYPE_WEIGHTS: Record<RecommendationFeatureKind, number> = {
	genre: 0.6,
	keyword: 1.6,
	cast: 0.7,
	/** Scaled further by the job's catalog weight, so a director lands near 1.3 and a composer near 1.1. */
	credit: 1.4,
	collection: 1.1,
};

export const RECOMMENDATION_SEED_DECAY = {
	fastHalfLifeDays: 45,
	slowHalfLifeDays: 365,
	fastShare: 0.35,
	slowShare: 0.65,
	floor: 0.1,
} as const;

export const RECOMMENDATION_SEED_MAX_WEIGHT = 1.5;
export const RECOMMENDATION_WATCHLIST_WEIGHT = 0.15;
/** Watchlist intent must never outweigh actual viewing history. */
export const RECOMMENDATION_WATCHLIST_SHARE_CAP = 0.3;

export const RECOMMENDATION_QUALITY_MIN_VOTES = 10;

export const RECOMMENDATION_SCORE_WEIGHTS = {
	profile: 0.55,
	seed: 0.35,
	negative: 0.3,
	quality: 0.05,
	freshness: 0.02,
	era: 0.02,
	specificity: 0.02,
} as const;

/** Largest share of a score that rating, freshness and era can move; content decides the rest. */
export const RECOMMENDATION_PRIOR_INFLUENCE = 0.3;

export const RECOMMENDATION_TYPE_AFFINITY = { base: 0.85, range: 0.15 } as const;

export const RECOMMENDATION_SEED_SIMILARITY_COUNT = 3;
/** Number of strongest seed buckets guaranteed a leader in the slate. */
export const RECOMMENDATION_SLATE_SEED_BUCKETS = 6;
export const RECOMMENDATION_FRESHNESS_DAYS = 90;
export const RECOMMENDATION_ERA_SIGMA_YEARS = 20;

/** A seed this close names the reason ("Because you watched X") when no collection or credit is shared. */
export const RECOMMENDATION_REASON_SEED_SIMILARITY = 0.2;

export const RECOMMENDATION_MMR_LAMBDA = 0.75;
export const RECOMMENDATION_MIN_ITEMS_PER_GENRE = 2;
export const RECOMMENDATION_MAX_ITEMS_PER_CREATOR = 2;
export const RECOMMENDATION_MAX_ITEMS_PER_COLLECTION = 1;

/** A profile with no real viewing gets this confidence haircut in the type mix. */
export const RECOMMENDATION_COLD_START_TYPE_SHARE = { movie: 0.5, tv_show: 0.5 } as const;
