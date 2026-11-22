import type { MetadataType } from "@reelvault/sdk/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import { HOUR } from "@/config/server/server.constants";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import type { DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import { MemoryCache } from "@/utils/memory.cache";
import {
	crewRoleWeight,
	keywordGenreConcentration,
	RECOMMENDATION_CREDIT_MIN_ROLE_WEIGHT,
	type RecommendationFeatureKind,
	type RecommendationFeatureRef,
	type RecommendationFeatureRow,
	type RecommendationFeatureStats,
	recommendationFeatureKey,
} from "@/utils/recommendation-feature.utils";
import { isNotNullish } from "@/utils/type.utils";

/**
 * The feature census changes only when metadata is written, and every metadata
 * write clears it through `invalidateReadCaches`. The TTL is only a safety net,
 * so the full-catalog census does not run on the request path every few minutes.
 */
const featureStatsCache = new MemoryCache<RecommendationFeatureStats>({
	ttlMs: HOUR,
	maxSize: 1,
	name: "recommendation.feature-stats",
});

/**
 * Crew job weights describe how the metadata providers name jobs, which barely
 * moves between scans, and reading them scans every crew row. They expire on
 * their own TTL instead of being dropped by every metadata write.
 */
const roleWeightsCache = new MemoryCache<ReadonlyMap<string, number>>({
	ttlMs: HOUR,
	maxSize: 1,
	name: "recommendation.role-weights",
});

/** Drops the census after a metadata write; the crew job weights stay. */
export function clearRecommendationFeatureCensus(): void {
	featureStatsCache.clear();
}

/** Drops the census and the crew job weights. */
export function clearRecommendationFeatureStats(): void {
	featureStatsCache.clear();
	roleWeightsCache.clear();
}

export interface RecommendationSeedRow {
	metadataId: string;
	type: MetadataType;
	status: string | null;
	releaseDate: string;
	watchedEpisodes: number;
	totalEpisodes: number | null;
	watchCount: number;
	lastWatchedAt: number | null;
	completionRatio: number;
	isFullWatch: boolean;
	rating: number | null;
	watchlistAddedAt: Date | null;
}

export interface RecommendationCandidateRow {
	id: string;
	type: MetadataType;
	popularity: number;
	releaseDate: string;
	createdAt: Date | null;
	latestMediaCreatedAt: Date | null;
	ratingValue: number | null;
	ratingVotes: number | null;
	maxValue: number | null;
}

interface RawSeedRow {
	metadataId: string;
	type: MetadataType;
	status: string | null;
	releaseDate: string;
	watchedEpisodes: number;
	totalEpisodes: number | null;
	watchCount: number;
	lastWatchedAt: number | null;
	completionRatio: number;
	isFullWatch: number;
	rating: number | null;
	watchlistAddedAt: number | null;
}

interface RawCandidateRow {
	id: string;
	type: MetadataType;
	popularity: number;
	releaseDate: string;
	createdAt: number | null;
	latestMediaCreatedAt: number | null;
	ratingValue: number | null;
	ratingVotes: number | null;
	maxValue: number | null;
}

/** Provider ratings use different scales; bring every value onto 0–10. */
function normalizedRatingValue(value: number, maxValue: number): number {
	if (maxValue <= 0) return value;

	return (value / maxValue) * 10;
}

function secondsToDate(value: number | null): Date | null {
	return value === null ? null : new Date(value * 1000);
}

function toCandidateRow(row: RawCandidateRow): RecommendationCandidateRow {
	return {
		id: row.id,
		type: row.type,
		popularity: row.popularity,
		releaseDate: row.releaseDate,
		createdAt: secondsToDate(row.createdAt),
		latestMediaCreatedAt: secondsToDate(row.latestMediaCreatedAt),
		ratingValue: row.ratingValue === null || row.maxValue === null ? row.ratingValue : normalizedRatingValue(row.ratingValue, row.maxValue),
		ratingVotes: row.ratingVotes,
		maxValue: row.maxValue,
	};
}

export function findRecommendationSeedRows(profileId: string): RecommendationSeedRow[] {
	const client = databaseFactory.getClient();
	const rows = client.all<RawSeedRow>(sql`
		WITH seed_ids AS (
			SELECT DISTINCT ${schema.mediaFiles.metadataId} AS metadata_id
			FROM ${schema.watchedHistory}
			INNER JOIN ${schema.mediaFiles} ON ${schema.mediaFiles.id} = ${schema.watchedHistory.mediaFileId}
			WHERE ${schema.watchedHistory.profileId} = ${profileId}
			UNION
			SELECT DISTINCT ${schema.mediaFiles.metadataId}
			FROM ${schema.playbackProgress}
			INNER JOIN ${schema.mediaFiles} ON ${schema.mediaFiles.id} = ${schema.playbackProgress.mediaFileId}
			WHERE ${schema.playbackProgress.profileId} = ${profileId}
			UNION
			SELECT ${schema.watchlist.metadataId}
			FROM ${schema.watchlist}
			WHERE ${schema.watchlist.profileId} = ${profileId}
			UNION
			SELECT ${schema.userRatings.metadataId}
			FROM ${schema.userRatings}
			WHERE ${schema.userRatings.profileId} = ${profileId}
		),
		watched AS (
			SELECT ${schema.mediaFiles.metadataId} AS metadata_id,
				COUNT(*) AS watch_count,
				COUNT(DISTINCT ${schema.mediaFiles.episodeId}) AS watched_episodes,
				MAX(${schema.watchedHistory.watchedAt}) AS last_watched_at,
				MAX(CASE WHEN ${schema.watchedHistory.isFullWatch} THEN 1 ELSE 0 END) AS full_watch
			FROM ${schema.watchedHistory}
			INNER JOIN ${schema.mediaFiles} ON ${schema.mediaFiles.id} = ${schema.watchedHistory.mediaFileId}
			WHERE ${schema.watchedHistory.profileId} = ${profileId}
			GROUP BY ${schema.mediaFiles.metadataId}
		),
		progress AS (
			SELECT ${schema.mediaFiles.metadataId} AS metadata_id,
				MAX(CASE WHEN ${schema.playbackProgress.duration} > 0
					THEN CAST(${schema.playbackProgress.position} AS REAL) / ${schema.playbackProgress.duration}
					ELSE 0 END) AS completion_ratio,
				MAX(${schema.playbackProgress.updatedAt}) AS last_played_at
			FROM ${schema.playbackProgress}
			INNER JOIN ${schema.mediaFiles} ON ${schema.mediaFiles.id} = ${schema.playbackProgress.mediaFileId}
			WHERE ${schema.playbackProgress.profileId} = ${profileId}
			GROUP BY ${schema.mediaFiles.metadataId}
		),
		ratings AS (
			SELECT ${schema.userRatings.metadataId} AS metadata_id, MAX(${schema.userRatings.rating}) AS rating
			FROM ${schema.userRatings}
			WHERE ${schema.userRatings.profileId} = ${profileId}
			GROUP BY ${schema.userRatings.metadataId}
		),
		watchlist_items AS (
			SELECT ${schema.watchlist.metadataId} AS metadata_id, MAX(${schema.watchlist.createdAt}) AS added_at
			FROM ${schema.watchlist}
			WHERE ${schema.watchlist.profileId} = ${profileId}
			GROUP BY ${schema.watchlist.metadataId}
		),
		episode_totals AS (
			SELECT ${schema.seasons.metadataId} AS metadata_id, COUNT(*) AS total_episodes
			FROM ${schema.seasons}
			INNER JOIN ${schema.episodes} ON ${schema.episodes.seasonId} = ${schema.seasons.id}
			WHERE ${schema.episodes.episodeType} = 'regular'
				AND ${schema.seasons.metadataId} IN (SELECT metadata_id FROM seed_ids)
			GROUP BY ${schema.seasons.metadataId}
		)
		SELECT m.id AS metadataId,
			m.type AS type,
			m.status AS status,
			m.release_date AS releaseDate,
			COALESCE(w.watch_count, 0) AS watchCount,
			COALESCE(w.watched_episodes, 0) AS watchedEpisodes,
			COALESCE(w.last_watched_at, p.last_played_at) AS lastWatchedAt,
			COALESCE(p.completion_ratio, 0) AS completionRatio,
			COALESCE(w.full_watch, 0) AS isFullWatch,
			r.rating AS rating,
			wl.added_at AS watchlistAddedAt,
			e.total_episodes AS totalEpisodes
		FROM seed_ids s
		INNER JOIN ${schema.metadata} m ON m.id = s.metadata_id
		LEFT JOIN watched w ON w.metadata_id = s.metadata_id
		LEFT JOIN progress p ON p.metadata_id = s.metadata_id
		LEFT JOIN ratings r ON r.metadata_id = s.metadata_id
		LEFT JOIN watchlist_items wl ON wl.metadata_id = s.metadata_id
		LEFT JOIN episode_totals e ON e.metadata_id = s.metadata_id
	`);

	return rows.map((row) => ({
		metadataId: row.metadataId,
		type: row.type,
		status: row.status,
		releaseDate: row.releaseDate,
		watchedEpisodes: row.watchedEpisodes,
		totalEpisodes: row.totalEpisodes,
		watchCount: row.watchCount,
		lastWatchedAt: row.lastWatchedAt === null ? null : row.lastWatchedAt * 1000,
		completionRatio: row.completionRatio,
		isFullWatch: row.isFullWatch === 1,
		rating: row.rating,
		watchlistAddedAt: secondsToDate(row.watchlistAddedAt),
	}));
}

interface RawFeatureStatRow {
	kind: RecommendationFeatureKind;
	id: string;
	df: number;
}

interface RawKeywordGenreRow {
	keywordId: string;
	genreId: string;
	n: number;
}

/** The same object is returned until the census is cleared, so callers can key derived caches on it. */
export function findRecommendationFeatureStats(): RecommendationFeatureStats {
	const cached = featureStatsCache.get("stats");
	if (cached) return cached;

	const stats = readRecommendationFeatureStats();
	featureStatsCache.set("stats", stats);

	return stats;
}

interface RawRoleRow {
	job: string;
	titles: number;
	credits: number;
	typeTitles: number;
}

/** Weight of every crew job worth keeping, computed per title type and kept at its best type. */
function readCrewRoleWeights(client: ReturnType<typeof databaseFactory.getClient>): Map<string, number> {
	const rows = client.all<RawRoleRow>(sql`
		WITH typed AS (
			SELECT ${schema.metadata.type} AS type, ${schema.metadataCrew.job} AS job, ${schema.metadataCrew.metadataId} AS metadata_id
			FROM ${schema.metadataCrew}
			INNER JOIN ${schema.metadata} ON ${schema.metadata.id} = ${schema.metadataCrew.metadataId}
		),
		type_totals AS (
			SELECT type, COUNT(DISTINCT metadata_id) AS titles FROM typed GROUP BY type
		)
		SELECT typed.job AS job,
			COUNT(DISTINCT typed.metadata_id) AS titles,
			COUNT(*) AS credits,
			type_totals.titles AS typeTitles
		FROM typed
		INNER JOIN type_totals ON type_totals.type = typed.type
		GROUP BY typed.type, typed.job
	`);
	const weights = new Map<string, number>();
	for (const row of rows) {
		const weight = crewRoleWeight(row.titles, row.typeTitles, row.credits);
		if (weight < RECOMMENDATION_CREDIT_MIN_ROLE_WEIGHT) continue;

		weights.set(row.job, Math.max(weights.get(row.job) ?? 0, weight));
	}

	return weights;
}

/**
 * Weight of every informative crew job (`crewRoleWeight`), shared by Discover
 * and the similar-titles list. A caller inside a transaction reads its own
 * database uncached.
 */
export function findCrewRoleWeights(tx?: DatabaseTransaction): ReadonlyMap<string, number> {
	if (tx) return readCrewRoleWeights(databaseFactory.getClient({ tx }));

	const cached = roleWeightsCache.get("roles");
	if (cached) return cached;

	const weights = readCrewRoleWeights(databaseFactory.getClient());
	roleWeightsCache.set("roles", weights);

	return weights;
}

function readRecommendationFeatureStats(): RecommendationFeatureStats {
	const client = databaseFactory.getClient();
	const totalTitles = client.get<{ total: number }>(sql`SELECT COUNT(*) AS total FROM ${schema.metadata}`).total;
	const roleWeights = findCrewRoleWeights();
	const rolesJson = JSON.stringify([...roleWeights.keys()]);

	const rows = client.all<RawFeatureStatRow>(sql`
			SELECT 'genre' AS kind, ${schema.metadataGenres.genreId} AS id,
				COUNT(DISTINCT ${schema.metadataGenres.metadataId}) AS df
			FROM ${schema.metadataGenres}
			GROUP BY ${schema.metadataGenres.genreId}
			UNION ALL
			SELECT 'keyword' AS kind, ${schema.metadataKeywords.keywordId} AS id,
				COUNT(DISTINCT ${schema.metadataKeywords.metadataId}) AS df
			FROM ${schema.metadataKeywords}
			GROUP BY ${schema.metadataKeywords.keywordId}
			UNION ALL
			SELECT 'cast' AS kind, ${schema.metadataCast.personId} AS id,
				COUNT(DISTINCT ${schema.metadataCast.metadataId}) AS df
			FROM ${schema.metadataCast}
			GROUP BY ${schema.metadataCast.personId}
			UNION ALL
			SELECT 'credit' AS kind, person_id AS id, COUNT(*) AS df
			FROM (
				SELECT DISTINCT ${schema.metadataCrew.personId} AS person_id, ${schema.metadataCrew.metadataId} AS metadata_id
				FROM ${schema.metadataCrew}
				WHERE ${schema.metadataCrew.job} IN (SELECT value FROM json_each(${rolesJson}))
			)
			GROUP BY person_id
			UNION ALL
			SELECT 'collection' AS kind, ${schema.metadataCollections.collectionId} AS id,
				COUNT(DISTINCT ${schema.metadataCollections.metadataId}) AS df
			FROM ${schema.metadataCollections}
			GROUP BY ${schema.metadataCollections.collectionId}
		`);

	const meanRow = client.get<{ mean: number | null }>(sql`
			SELECT AVG(${schema.metadataRatings.value} / ${schema.metadataRatings.maxValue} * 10) AS mean
			FROM ${schema.metadataRatings}
			WHERE ${schema.metadataRatings.votes} > 0 AND ${schema.metadataRatings.maxValue} > 0
		`);
	const keywordGenreRows = client.all<RawKeywordGenreRow>(sql`
			SELECT ${schema.metadataKeywords.keywordId} AS keywordId,
				${schema.metadataGenres.genreId} AS genreId,
				COUNT(DISTINCT ${schema.metadataKeywords.metadataId}) AS n
			FROM ${schema.metadataKeywords}
			INNER JOIN ${schema.metadataGenres} ON ${schema.metadataGenres.metadataId} = ${schema.metadataKeywords.metadataId}
			GROUP BY ${schema.metadataKeywords.keywordId}, ${schema.metadataGenres.genreId}
		`);
	const documentFrequency = new Map<string, number>();
	for (const row of rows) {
		if (row.df <= 0) continue;

		documentFrequency.set(recommendationFeatureKey(row.kind, row.id), row.df);
	}

	const genresByKeyword = new Map<string, Map<string, number>>();
	for (const row of keywordGenreRows) {
		let counts = genresByKeyword.get(row.keywordId);
		if (!counts) {
			counts = new Map();
			genresByKeyword.set(row.keywordId, counts);
		}
		counts.set(row.genreId, row.n);
	}
	const keywordConcentration = new Map<string, number>();
	for (const [keywordId, counts] of genresByKeyword) {
		keywordConcentration.set(recommendationFeatureKey("keyword", keywordId), keywordGenreConcentration(counts));
	}

	return {
		totalTitles,
		documentFrequency,
		globalMeanRating: meanRow.mean ?? 6.5,
		keywordConcentration,
		roleWeights,
	};
}

export function findRecommendationCandidates({
	features,
	excludeIds,
	limit,
	creditRoles,
}: {
	features: readonly RecommendationFeatureRef[];
	excludeIds: readonly string[];
	limit: number;
	/** Crew jobs that count as credits (the census's `roleWeights` keys). */
	creditRoles: readonly string[];
}): RecommendationCandidateRow[] {
	if (features.length === 0) return [];

	const client = databaseFactory.getClient();
	const idsByKind = new Map<RecommendationFeatureKind, string[]>();
	for (const feature of features) {
		const ids = idsByKind.get(feature.kind) ?? [];
		ids.push(feature.id);
		idsByKind.set(feature.kind, ids);
	}

	const branches: Array<ReturnType<typeof sql>> = [];

	const genreIds = idsByKind.get("genre");
	if (genreIds) {
		branches.push(
			sql`SELECT DISTINCT ${schema.metadataGenres.metadataId} AS metadata_id FROM ${schema.metadataGenres} WHERE ${inArray(schema.metadataGenres.genreId, genreIds)}`,
		);
	}
	const keywordIds = idsByKind.get("keyword");
	if (keywordIds) {
		branches.push(
			sql`SELECT DISTINCT ${schema.metadataKeywords.metadataId} AS metadata_id FROM ${schema.metadataKeywords} WHERE ${inArray(schema.metadataKeywords.keywordId, keywordIds)}`,
		);
	}
	const castIds = idsByKind.get("cast");
	if (castIds) {
		branches.push(
			sql`SELECT DISTINCT ${schema.metadataCast.metadataId} AS metadata_id FROM ${schema.metadataCast} WHERE ${inArray(schema.metadataCast.personId, castIds)} AND ${schema.metadataCast.sortOrder} <= 4`,
		);
	}
	const collectionIds = idsByKind.get("collection");
	if (collectionIds) {
		branches.push(
			sql`SELECT DISTINCT ${schema.metadataCollections.metadataId} AS metadata_id FROM ${schema.metadataCollections} WHERE ${inArray(schema.metadataCollections.collectionId, collectionIds)}`,
		);
	}
	const creditIds = idsByKind.get("credit");
	if (creditIds && creditRoles.length > 0) {
		branches.push(
			sql`SELECT DISTINCT ${schema.metadataCrew.metadataId} AS metadata_id FROM ${schema.metadataCrew} WHERE ${inArray(schema.metadataCrew.personId, creditIds)} AND ${inArray(schema.metadataCrew.job, [...creditRoles])}`,
		);
	}

	if (branches.length === 0) return [];

	const excludeJson = JSON.stringify(excludeIds);
	const rows = client.all<RawCandidateRow>(sql`
		SELECT m.id AS id,
			m.type AS type,
			m.popularity AS popularity,
			m.release_date AS releaseDate,
			m.created_at AS createdAt,
			m.latest_media_created_at AS latestMediaCreatedAt,
			NULL AS ratingValue,
			NULL AS ratingVotes,
			NULL AS maxValue,
			COUNT(*) AS hits
		FROM (${sql.join(branches, sql` UNION ALL `)}) AS matches
		INNER JOIN ${schema.metadata} m ON m.id = matches.metadata_id
		WHERE m.latest_media_created_at IS NOT NULL
			AND m.id NOT IN (SELECT value FROM json_each(${excludeJson}))
		GROUP BY m.id
		ORDER BY hits DESC, m.popularity DESC, m.created_at DESC
		LIMIT ${limit}
	`);

	return rows.map((row) => toCandidateRow(row));
}

/**
 * Best-rated titles with media, the candidate source for cold start, small
 * catalogs and the short-slate backfill. `type` narrows it to one row of Discover.
 */
export function findRecommendationFallbackCandidates({
	excludeIds,
	limit,
	type,
}: {
	excludeIds: readonly string[];
	limit: number;
	type?: MetadataType;
}): RecommendationCandidateRow[] {
	const client = databaseFactory.getClient();
	const excludeJson = JSON.stringify(excludeIds);
	const typeFilter = type === undefined ? sql.raw("") : sql`AND m.type = ${type}`;
	const rows = client.all<RawCandidateRow>(sql`
		SELECT m.id AS id,
			m.type AS type,
			m.popularity AS popularity,
			m.release_date AS releaseDate,
			m.created_at AS createdAt,
			m.latest_media_created_at AS latestMediaCreatedAt,
			r.value AS ratingValue,
			r.votes AS ratingVotes,
			r.maxValue AS maxValue
		FROM ${schema.metadata} m
		LEFT JOIN (
			SELECT metadata_id, value, votes, ${schema.metadataRatings.maxValue} AS maxValue,
				ROW_NUMBER() OVER (PARTITION BY metadata_id ORDER BY votes DESC, value DESC) AS rating_rank
			FROM ${schema.metadataRatings}
			WHERE metadata_id IN (
				SELECT ${schema.metadata.id} FROM ${schema.metadata}
				WHERE ${schema.metadata.latestMediaCreatedAt} IS NOT NULL
					AND ${schema.metadata.id} NOT IN (SELECT value FROM json_each(${excludeJson}))
			)
		) r ON r.metadata_id = m.id AND r.rating_rank = 1
		WHERE m.latest_media_created_at IS NOT NULL
			AND m.id NOT IN (SELECT value FROM json_each(${excludeJson}))
			${typeFilter}
		ORDER BY COALESCE(r.value / NULLIF(r.maxValue, 0) * 10, 0) DESC, m.popularity DESC, m.latest_media_created_at DESC
		LIMIT ${limit}
	`);

	return rows.map((row) => toCandidateRow(row));
}

export function findRecommendationFeatureRows(metadataIds: readonly string[], creditRoles: readonly string[]): RecommendationFeatureRow[] {
	if (metadataIds.length === 0) return [];

	const client = databaseFactory.getClient();
	const idsJson = JSON.stringify(metadataIds);
	const rolesJson = JSON.stringify(creditRoles);
	const rows = client.all<RecommendationFeatureRow>(sql`
		SELECT DISTINCT ${schema.metadataGenres.metadataId} AS metadataId,
			'genre' AS kind,
			${schema.metadataGenres.genreId} AS id,
			${schema.genres.name} AS label,
			NULL AS role
		FROM ${schema.metadataGenres}
		INNER JOIN ${schema.genres} ON ${schema.genres.id} = ${schema.metadataGenres.genreId}
		WHERE ${schema.metadataGenres.metadataId} IN (SELECT value FROM json_each(${idsJson}))
		UNION ALL
		SELECT DISTINCT ${schema.metadataKeywords.metadataId},
			'keyword' AS kind,
			${schema.metadataKeywords.keywordId},
			${schema.keywords.name},
			NULL
		FROM ${schema.metadataKeywords}
		INNER JOIN ${schema.keywords} ON ${schema.keywords.id} = ${schema.metadataKeywords.keywordId}
		WHERE ${schema.metadataKeywords.metadataId} IN (SELECT value FROM json_each(${idsJson}))
		UNION ALL
		SELECT DISTINCT ${schema.metadataCast.metadataId},
			'cast' AS kind,
			${schema.metadataCast.personId},
			${schema.people.name},
			NULL
		FROM ${schema.metadataCast}
		INNER JOIN ${schema.people} ON ${schema.people.id} = ${schema.metadataCast.personId}
		WHERE ${schema.metadataCast.metadataId} IN (SELECT value FROM json_each(${idsJson}))
			AND ${schema.metadataCast.sortOrder} <= 4
		UNION ALL
		SELECT ${schema.metadataCrew.metadataId},
			'credit' AS kind,
			${schema.metadataCrew.personId},
			${schema.people.name},
			${schema.metadataCrew.job}
		FROM ${schema.metadataCrew}
		INNER JOIN ${schema.people} ON ${schema.people.id} = ${schema.metadataCrew.personId}
		WHERE ${schema.metadataCrew.metadataId} IN (SELECT value FROM json_each(${idsJson}))
			AND ${schema.metadataCrew.job} IN (SELECT value FROM json_each(${rolesJson}))
		UNION ALL
		SELECT DISTINCT ${schema.metadataCollections.metadataId},
			'collection' AS kind,
			${schema.metadataCollections.collectionId},
			${schema.collections.name},
			NULL
		FROM ${schema.metadataCollections}
		INNER JOIN ${schema.collections} ON ${schema.collections.id} = ${schema.metadataCollections.collectionId}
		WHERE ${schema.metadataCollections.metadataId} IN (SELECT value FROM json_each(${idsJson}))
	`);

	return rows.filter((row): row is RecommendationFeatureRow => isNotNullish(row.metadataId) && isNotNullish(row.id));
}

export function findRecommendationQuality(metadataIds: readonly string[]): Map<string, { value: number; votes: number }> {
	if (metadataIds.length === 0) return new Map();

	const client = databaseFactory.getClient();
	const idsJson = JSON.stringify(metadataIds);
	const rows = client.all<{ metadataId: string; value: number; votes: number; maxValue: number }>(sql`
		SELECT ${schema.metadataRatings.metadataId} AS metadataId,
			${schema.metadataRatings.value} AS value,
			${schema.metadataRatings.votes} AS votes,
			${schema.metadataRatings.maxValue} AS maxValue
		FROM ${schema.metadataRatings}
		WHERE ${schema.metadataRatings.metadataId} IN (SELECT value FROM json_each(${idsJson}))
			AND ${schema.metadataRatings.votes} > 0
		ORDER BY ${schema.metadataRatings.metadataId}, ${schema.metadataRatings.votes} DESC
	`);
	const quality = new Map<string, { value: number; votes: number }>();
	for (const row of rows) {
		if (quality.has(row.metadataId)) continue;

		quality.set(row.metadataId, {
			value: normalizedRatingValue(row.value, row.maxValue),
			votes: row.votes,
		});
	}

	return quality;
}

/** Titles of the seeds a "Because you watched" reason names. */
export function findMetadataTitles(metadataIds: readonly string[]): Map<string, string> {
	if (metadataIds.length === 0) return new Map();

	const rows = databaseFactory
		.getClient()
		.select({ id: schema.metadata.id, title: schema.metadata.title })
		.from(schema.metadata)
		.where(inArray(schema.metadata.id, [...metadataIds]))
		.all();

	return new Map(rows.map((row) => [row.id, row.title]));
}

export async function findDislikedMetadataIds(profileId: string): Promise<Set<string>> {
	const client = databaseFactory.getClient();
	const rows = await client
		.select({ metadataId: schema.userRatings.metadataId })
		.from(schema.userRatings)
		.where(and(eq(schema.userRatings.profileId, profileId), eq(schema.userRatings.rating, 0)));

	return new Set(rows.map((row) => row.metadataId));
}
