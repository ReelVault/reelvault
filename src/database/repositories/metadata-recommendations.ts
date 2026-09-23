import type { FieldsConfig, MetadataWithRelation, SelectFields } from "@reelvault/sdk/common";
import { and, count, desc, eq, inArray, ne, or, type SQL, sql } from "drizzle-orm";
import { databaseFactory } from "@/database/database";
import { schema } from "@/database/schema";
import type { DatabaseTransaction } from "@/database/types";
import { systemResourcesService } from "@/system/system-resources.service";
import { isNotNullish, pluckValidIds, toMap } from "@/utils/array.utils";
import { MemoryCache } from "@/utils/memory-cache";

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
	maxSize: systemResourcesService.getRamScaledCacheEntries(128, 512, 2048),
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

		if (row.kind === "collection") collections.push({ id: row.id });
		else if (row.kind === "genre") genres.push({ id: row.id });
		else if (row.kind === "keyword") keywords.push({ id: row.id });
		else if (row.kind === "crew") crew.push({ job: row.extra, data: { id: row.id } });
		else cast.push({ role: row.extra, sortOrder: row.sortOrder, data: { id: row.id } });
	}

	return { type: metadataRow.type, collections, genres, keywords, crew, cast };
}

async function rankSimilarIds(
	client: MoreLikeThisClient,
	metadataId: string,
	source: MoreLikeThisSource,
	limit: number,
	offset: number,
): Promise<{ ids: string[]; total: number }> {
	// Prepare the ID sets for the shared traits.
	// Prepare the ID sets for the shared traits
	const collectionIds = pluckValidIds(source.collections);
	const genreIds = pluckValidIds(source.genres);
	const keywordIds = pluckValidIds(source.keywords);

	// Single-pass: directors + top 5 cast
	const directors: string[] = [];
	const topCastCandidates: Array<{ id: string; sortOrder: number }> = [];
	for (const c of source.crew ?? []) {
		if (c.job?.toLowerCase().includes("director") && c.data?.id) directors.push(c.data.id);
	}

	for (const c of source.cast ?? []) {
		if ((c.role?.toLowerCase().includes("actor") || !c.role) && c.data?.id) {
			topCastCandidates.push({ id: c.data.id, sortOrder: c.sortOrder ?? 0 });
		}
	}

	topCastCandidates.sort((a, b) => a.sortOrder - b.sortOrder);
	const topCast = topCastCandidates.slice(0, 5).map((c) => c.id);

	// 2. Build the scoring queries
	// Weights chosen so collection and director rank highest, right after genre
	const collectionScore =
		collectionIds.length > 0
			? sql`(CASE WHEN EXISTS (SELECT 1 FROM ${schema.metadataCollections} WHERE ${schema.metadataCollections.metadataId} = ${schema.metadata.id} AND ${inArray(schema.metadataCollections.collectionId, collectionIds)}) THEN -100 ELSE 0 END)`
			: sql`0`;

	const genreScore =
		genreIds.length > 0
			? sql`(SELECT COUNT(*) * 30 FROM ${schema.metadataGenres} WHERE ${schema.metadataGenres.metadataId} = ${schema.metadata.id} AND ${inArray(schema.metadataGenres.genreId, genreIds)})`
			: sql`0`;

	const keywordScore =
		keywordIds.length > 0
			? sql`(SELECT COUNT(*) * 12 FROM ${schema.metadataKeywords} WHERE ${schema.metadataKeywords.metadataId} = ${schema.metadata.id} AND ${inArray(schema.metadataKeywords.keywordId, keywordIds)})`
			: sql`0`;

	const directorScore =
		directors.length > 0
			? sql`(CASE WHEN EXISTS (SELECT 1 FROM ${schema.metadataCrew} WHERE ${schema.metadataCrew.metadataId} = ${schema.metadata.id} AND ${schema.metadataCrew.job} LIKE '%Director%' AND ${inArray(schema.metadataCrew.personId, directors)}) THEN 80 ELSE 0 END)`
			: sql`0`;

	const castScore =
		topCast.length > 0
			? sql`(SELECT COUNT(*) * 15 FROM ${schema.metadataCast} WHERE ${schema.metadataCast.metadataId} = ${schema.metadata.id} AND ${inArray(schema.metadataCast.personId, topCast)})`
			: sql`0`;

	// Prefer the same type (movie -> movies, show -> show)
	const typeScore = sql`CASE WHEN ${schema.metadata.type} = ${source.type} THEN 50 ELSE 0 END`;

	// First we narrow the candidate set. Every subset uses the index
	// on the other side of the junction, so scoring never scans the whole metadata table.
	const candidateFeatureFilters: SQL[] = [];
	const featureGroups = [
		{ ids: collectionIds, table: schema.metadataCollections, column: schema.metadataCollections.collectionId },
		{ ids: genreIds, table: schema.metadataGenres, column: schema.metadataGenres.genreId },
		{ ids: keywordIds, table: schema.metadataKeywords, column: schema.metadataKeywords.keywordId },
		{ ids: directors, table: schema.metadataCrew, column: schema.metadataCrew.personId },
		{ ids: topCast, table: schema.metadataCast, column: schema.metadataCast.personId },
	];
	for (const group of featureGroups) {
		if (group.ids.length > 0) {
			// Drive the candidate set from the (small) junction side: `id IN (...)`
			// lets SQLite start at the trait matches instead of scanning every row of
			// the type and probing each one with a correlated EXISTS.
			candidateFeatureFilters.push(
				inArray(
					schema.metadata.id,
					client.select({ id: group.table.metadataId }).from(group.table).where(inArray(group.column, group.ids)),
				),
			);
		}
	}

	const candidateFilter = candidateFeatureFilters.length > 0 ? or(...candidateFeatureFilters) : undefined;
	const typeFilter = source.type ? eq(schema.metadata.type, source.type) : undefined;

	// 3. Run the ID + similarity-score query. `COUNT(*) OVER ()` returns the
	// filtered total in the same pass, so the expensive 5x-EXISTS count scan is
	// only needed when an empty page sits past the end (no rows to read it from).
	const candidateWhere = and(ne(schema.metadata.id, metadataId), typeFilter, candidateFilter);
	const recommendedWithProbe = await client
		.select({
			id: schema.metadata.id,
			score: sql<number>`(${collectionScore} + ${genreScore} + ${keywordScore} + ${directorScore} + ${castScore} + ${typeScore})`.as(
				"score",
			),
			total: sql<number>`COUNT(*) OVER ()`.as("total"),
		})
		.from(schema.metadata)
		.where(candidateWhere)
		.orderBy((t) => desc(t.score))
		.limit(limit + 1)
		.offset(offset);

	const hasMore = recommendedWithProbe.length > limit;
	const recommendedIds = hasMore ? recommendedWithProbe.slice(0, limit) : recommendedWithProbe;
	let total = recommendedWithProbe[0]?.total ?? 0;
	if (recommendedIds.length === 0 && offset > 0) {
		const totalRows = await client.select({ value: count() }).from(schema.metadata).where(candidateWhere);
		total = totalRows[0]?.value ?? 0;
	}

	const ids = recommendedIds.map((r) => r.id);

	return { ids, total };
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

		page = await rankSimilarIds(client, metadataId, source, limit, offset);
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
