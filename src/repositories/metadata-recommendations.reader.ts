import type { FieldsConfig, MetadataWithRelation, SelectFields } from "@reelvault/sdk/common";
import { eq, inArray, like, type SQL, sql } from "drizzle-orm";
import { systemResourcesService } from "@/config/system-resources.service";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import type { DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import { pluckValidIds, toMap } from "@/utils/array.utils";
import { MemoryCache } from "@/utils/memory.cache";
import { isNotNullish } from "@/utils/type.utils";

const RATING_DEFAULT_SOURCE_WEIGHT = 1;

/**
 * The "more like this" scoring pass (trait load + 5 correlated subqueries) is
 * the most expensive repository read and its result depends only on the source
 * title's traits — never on the viewer. Caching the ranked id page per
 * (metadataId, limit, offset) lets every profile share one computation. Bounded
 * by the route's client max-age (60 s); catalog changes surface within the TTL.
 */
const similarIdsCache = new MemoryCache<{ ids: string[]; total: number }>({
	ttlMs: 60_000,
	maxSize: systemResourcesService.getRamScaled(128, 512, 2048),
	name: "metadata.similarIds",
});

/** Drops the ranked id pages — call on metadata writes so similar lists refresh. */
export function clearSimilarIdsCache(): void {
	similarIdsCache.clear();
}

function ratingSourceWeight(votes: number | null | undefined): number {
	if (!votes || votes <= 0) return RATING_DEFAULT_SOURCE_WEIGHT;

	return 1 + Math.log10(1 + votes);
}

export type RatingAggregationStrategy = "votes" | "simple";

export type MetadataContentType = "movie" | "tv_show";

export interface MoreLikeThisSource {
	type?: MetadataContentType | null | undefined;
	collections?: Array<{ id: string }> | undefined;
	genres?: Array<{ id: string }> | undefined;
	keywords?: Array<{ id: string }> | undefined;
	crew?: Array<{ job?: string | null | undefined; data?: { id?: string | null | undefined } | null | undefined }> | undefined;
	cast?:
		| Array<{
				role?: string | null | undefined;
				sortOrder?: number | null | undefined;
				data?: { id?: string | null | undefined } | null | undefined;
		  }>
		| undefined;
}

/**
 * Averages provider ratings on a /10 scale. The default `votes` strategy weights
 * each source by its vote count (log-scaled, floor 1) so high-volume sources like
 * IMDb dominate over sources without votes while still contributing to the blend;
 * `simple` averages every source equally. Configurable via `metadata.ratingAggregation`.
 */
export function calculateAverageScore(
	ratings: Array<{ value?: number | null; maxValue?: number | null; votes?: number | null } | null | undefined>,
	strategy: RatingAggregationStrategy = "votes",
): number | undefined {
	const validRatings = ratings.filter((rating) => isNotNullish(rating));
	if (validRatings.length === 0) {
		return undefined;
	}

	if (strategy === "simple") {
		let totalScore = 0;
		for (const rating of validRatings) {
			const value = rating.value ?? 0;
			const maxValue = rating.maxValue ?? 10;
			totalScore += (value / maxValue) * 10;
		}

		return Math.round((totalScore / validRatings.length) * 100) / 100;
	}

	let weightedScore = 0;
	let totalWeight = 0;
	for (const rating of validRatings) {
		const value = rating.value ?? 0;
		const maxValue = rating.maxValue ?? 10;
		const weight = ratingSourceWeight(rating.votes);
		weightedScore += (value / maxValue) * 10 * weight;
		totalWeight += weight;
	}

	if (totalWeight <= 0) return undefined;

	return Math.round((weightedScore / totalWeight) * 100) / 100;
}

export interface MoreLikeThisHost {
	logger: { warn(message: string, context?: Record<string, unknown>): void };
	findMany<F extends string>(params: {
		where?: SQL | undefined;
		fields?: FieldsConfig<F> | undefined;
		tx?: DatabaseTransaction | undefined;
	}): Promise<Array<SelectFields<MetadataWithRelation, F>>>;
}

type MoreLikeThisClient = ReturnType<typeof databaseFactory.getClient>;

/**
 * Raw SQL is deliberate here: the trait UNION ALL, the score CTE and the
 * window total must stay in one statement to preserve the ranked-page plan.
 * Every table and column is interpolated from `schema`, so a rename fails at
 * compile time instead of drifting into a string literal.
 *
 * Loads a source title's shared traits in 2 statements (metadata row + one
 * junction UNION ALL) instead of "metadata row + 5 relation loads". SQLite is
 * single-threaded, so fewer synchronous statements per request directly raise
 * throughput under concurrency.
 */
async function loadSourceTraits(client: MoreLikeThisClient, metadataId: string): Promise<MoreLikeThisSource | undefined> {
	const [metadataRow] = await client
		.select({ type: schema.metadata.type })
		.from(schema.metadata)
		.where(eq(schema.metadata.id, metadataId))
		.limit(1);
	if (!metadataRow) return undefined;

	const traitRows = client.all<{ kind: string; id: string | null; extra: string | null; sortOrder: number | null }>(sql`
		SELECT 'collection' AS kind, collection_id AS id, NULL AS extra, NULL AS sortOrder FROM ${schema.metadataCollections} WHERE metadata_id = ${metadataId}
		UNION ALL
		SELECT 'genre', genre_id, NULL, NULL FROM ${schema.metadataGenres} WHERE metadata_id = ${metadataId}
		UNION ALL
		SELECT 'keyword', keyword_id, NULL, NULL FROM ${schema.metadataKeywords} WHERE metadata_id = ${metadataId}
		UNION ALL
		SELECT 'cast', person_id, role, sort_order FROM ${schema.metadataCast} WHERE metadata_id = ${metadataId}
		UNION ALL
		SELECT 'crew', person_id, job, NULL FROM ${schema.metadataCrew} WHERE metadata_id = ${metadataId}
	`);

	const collections: Array<{ id: string }> = [];
	const genres: Array<{ id: string }> = [];
	const keywords: Array<{ id: string }> = [];
	const crew: NonNullable<MoreLikeThisSource["crew"]> = [];
	const cast: NonNullable<MoreLikeThisSource["cast"]> = [];
	for (const row of traitRows) {
		if (!row.id) continue;

		switch (row.kind) {
			case "collection":
				collections.push({ id: row.id });
				break;
			case "genre":
				genres.push({ id: row.id });
				break;
			case "keyword":
				keywords.push({ id: row.id });
				break;
			case "crew":
				crew.push({ job: row.extra, data: { id: row.id } });
				break;
			default:
				cast.push({ role: row.extra, sortOrder: row.sortOrder, data: { id: row.id } });
		}
	}

	return { type: metadataRow.type, collections, genres, keywords, crew, cast };
}

interface SimilarityTraits {
	collectionIds: string[];
	genreIds: string[];
	keywordIds: string[];
	directors: string[];
	topCast: string[];
}

/**
 * One row per matching trait. Collection and director rows are DISTINCT because
 * their score is an EXISTS bonus, not a count; genre, keyword and cast rows keep
 * one row per match because those scores multiply by the match count.
 */
function buildTraitUnion(traits: SimilarityTraits): SQL | undefined {
	const parts: SQL[] = [];

	if (traits.collectionIds.length > 0) {
		parts.push(
			sql`SELECT DISTINCT ${schema.metadataCollections.metadataId} AS metadata_id, 'collection' AS kind, -100 AS weight FROM ${schema.metadataCollections} WHERE ${inArray(schema.metadataCollections.collectionId, traits.collectionIds)}`,
		);
	}
	if (traits.genreIds.length > 0) {
		parts.push(
			sql`SELECT ${schema.metadataGenres.metadataId} AS metadata_id, 'genre' AS kind, 30 AS weight FROM ${schema.metadataGenres} WHERE ${inArray(schema.metadataGenres.genreId, traits.genreIds)}`,
		);
	}
	if (traits.keywordIds.length > 0) {
		parts.push(
			sql`SELECT ${schema.metadataKeywords.metadataId} AS metadata_id, 'keyword' AS kind, 12 AS weight FROM ${schema.metadataKeywords} WHERE ${inArray(schema.metadataKeywords.keywordId, traits.keywordIds)}`,
		);
	}
	if (traits.directors.length > 0) {
		parts.push(
			sql`SELECT DISTINCT ${schema.metadataCrew.metadataId} AS metadata_id, 'director' AS kind, 80 AS weight FROM ${schema.metadataCrew} WHERE ${like(schema.metadataCrew.job, "%Director%")} AND ${inArray(schema.metadataCrew.personId, traits.directors)}`,
		);
	}
	if (traits.topCast.length > 0) {
		parts.push(
			sql`SELECT ${schema.metadataCast.metadataId} AS metadata_id, 'cast' AS kind, 15 AS weight FROM ${schema.metadataCast} WHERE ${inArray(schema.metadataCast.personId, traits.topCast)}`,
		);
	}

	return parts.length > 0 ? sql.join(parts, sql` UNION ALL `) : undefined;
}

function buildScoresCte(traits: SQL): SQL {
	return sql`WITH traits AS (${traits}), scores AS (
		SELECT metadata_id,
			SUM(CASE kind WHEN 'genre' THEN 30 WHEN 'keyword' THEN 12 WHEN 'cast' THEN 15 ELSE 0 END)
			+ CASE WHEN MAX(CASE WHEN kind = 'collection' THEN 1 ELSE 0 END) = 1 THEN -100 ELSE 0 END
			+ CASE WHEN MAX(CASE WHEN kind = 'director' THEN 1 ELSE 0 END) = 1 THEN 80 ELSE 0 END AS weight
		FROM traits
		GROUP BY metadata_id
	)`;
}

interface RankedRow {
	id: string;
	score: number;
	total: number;
}

interface SimilarPageContext {
	client: MoreLikeThisClient;
	metadataId: string;
	typeScore: number;
	typeFilter: SQL;
	limit: number;
	offset: number;
}

function collectSimilarityTraits(source: MoreLikeThisSource): SimilarityTraits {
	const directors: string[] = [];
	const topCastCandidates: Array<{ id: string; sortOrder: number }> = [];
	for (const crew of source.crew ?? []) {
		if (crew.job?.toLowerCase().includes("director") && crew.data?.id) directors.push(crew.data.id);
	}
	for (const cast of source.cast ?? []) {
		if ((cast.role?.toLowerCase().includes("actor") || !cast.role) && cast.data?.id) {
			topCastCandidates.push({ id: cast.data.id, sortOrder: cast.sortOrder ?? 0 });
		}
	}

	topCastCandidates.sort((a, b) => a.sortOrder - b.sortOrder);

	return {
		collectionIds: pluckValidIds(source.collections),
		genreIds: pluckValidIds(source.genres),
		keywordIds: pluckValidIds(source.keywords),
		directors,
		topCast: topCastCandidates.slice(0, 5).map((cast) => cast.id),
	};
}

function readFallbackRows({ client, metadataId, typeScore, typeFilter, limit, offset }: SimilarPageContext): RankedRow[] {
	return client.all<RankedRow>(sql`
		SELECT m.id AS id, ${typeScore} AS score, COUNT(*) OVER () AS total
		FROM ${schema.metadata} AS m
		WHERE m.id <> ${metadataId}${typeFilter}
		ORDER BY score DESC, m.id DESC
		LIMIT ${limit + 1} OFFSET ${offset}
	`);
}

function readFallbackTotal({ client, metadataId, typeFilter }: SimilarPageContext): number {
	return client.get<{ total: number }>(sql`SELECT COUNT(*) AS total FROM ${schema.metadata} AS m WHERE m.id <> ${metadataId}${typeFilter}`)
		.total;
}

function readScoredRows({ client, metadataId, typeScore, typeFilter, limit, offset }: SimilarPageContext, cte: SQL): RankedRow[] {
	return client.all<RankedRow>(sql`
		${cte}
		SELECT m.id AS id, scores.weight + ${typeScore} AS score, COUNT(*) OVER () AS total
		FROM scores CROSS JOIN ${schema.metadata} AS m ON m.id = scores.metadata_id
		WHERE m.id <> ${metadataId}${typeFilter}
		ORDER BY score DESC, m.id DESC
		LIMIT ${limit + 1} OFFSET ${offset}
	`);
}

function readScoredTotal({ client, metadataId, typeFilter }: SimilarPageContext, cte: SQL): number {
	return client.get<{ total: number }>(sql`
		${cte}
		SELECT COUNT(*) AS total
		FROM scores CROSS JOIN ${schema.metadata} AS m ON m.id = scores.metadata_id
		WHERE m.id <> ${metadataId}${typeFilter}
	`).total;
}

function pageIds(rows: RankedRow[], limit: number): string[] {
	return (rows.length > limit ? rows.slice(0, limit) : rows).map((row) => row.id);
}

function rankSimilarIds(
	client: MoreLikeThisClient,
	metadataId: string,
	source: MoreLikeThisSource,
	limit: number,
	offset: number,
): { ids: string[]; total: number } {
	const traits = collectSimilarityTraits(source);
	const context: SimilarPageContext = {
		client,
		metadataId,
		typeScore: source.type ? 50 : 0,
		typeFilter: source.type ? sql` AND m.type = ${source.type}` : sql``,
		limit,
		offset,
	};
	const traitUnion = buildTraitUnion(traits);

	if (!traitUnion) {
		const rows = readFallbackRows(context);
		const ids = pageIds(rows, limit);

		return { ids, total: ids.length === 0 && offset > 0 ? readFallbackTotal(context) : (rows[0]?.total ?? 0) };
	}

	const cte = buildScoresCte(traitUnion);
	const rows = readScoredRows(context, cte);
	const ids = pageIds(rows, limit);

	return { ids, total: ids.length === 0 && offset > 0 ? readScoredTotal(context, cte) : (rows[0]?.total ?? 0) };
}

export async function getMoreLikeThis<F extends string>(
	host: MoreLikeThisHost,
	{
		metadataId,
		source: preFetchedSource,
		fields,
		limit,
		offset,
		tx,
	}: {
		metadataId: string;
		source?: MoreLikeThisSource | undefined;
		fields?: FieldsConfig<F> | undefined;
		limit: number;
		offset: number;
		tx?: DatabaseTransaction | undefined;
	},
): Promise<{ total: number; data: Array<SelectFields<MetadataWithRelation, F>> }> {
	const client = databaseFactory.getClient({ tx });

	// The ranked id page is viewer-independent, so only the explicit `source`
	// override path (which can carry different traits) skips the shared cache.
	const cacheKey = `${metadataId}\u0000${limit}\u0000${offset}`;
	let page = preFetchedSource ? null : similarIdsCache.get(cacheKey);

	if (!page) {
		let source = preFetchedSource;
		if (!source) {
			source = await loadSourceTraits(client, metadataId);
			if (!source) {
				host.logger.warn("Metadata not found for recommendations", { metadataId });

				return { total: 0, data: [] };
			}
		}

		page = rankSimilarIds(client, metadataId, source, limit, offset);
		if (!preFetchedSource) similarIdsCache.set(cacheKey, page);
	}

	const { ids, total } = page;
	if (ids.length === 0) return { total, data: [] };

	// 4. Batch fetch final data (N+1 optimization)
	const data = await host.findMany({
		where: inArray(schema.metadata.id, ids),
		fields,
		tx,
	});

	// 5. Restore the original sort order over the results
	const dataMap = toMap(data, (item) => item.id);

	return { total, data: ids.map((id) => dataMap.get(id)).filter((v) => isNotNullish(v)) };
}
