import { inArray, lte, sql } from "drizzle-orm";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import type { DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import { metadataImageOn, posterImagesOn } from "@/integrations/drizzle-orm/utils/join-conditions.utils";
import { toMap } from "@/utils/array.utils";
import { MemoryCache } from "@/utils/memory.cache";
import { responseBodyEpoch } from "@/utils/response-body.cache";

export interface PosterImage {
	imageId: string;
	updatedAt: Date;
}

/** Member count and up to `PREVIEW_POSTER_COUNT` posters of one collection, as list pages embed them. */
export interface MetadataPreview {
	count: number;
	posterImages: PosterImage[];
}

interface CachedPreview extends MetadataPreview {
	/** responseBodyEpoch() when the preview was read; a later flush of list bodies makes it stale. */
	epoch: number;
}

const PREVIEW_POSTER_COUNT = 4;

/** Upper bound on how long a preview may outlive its read, even without a write to flush it. */
const COLLECTION_PREVIEW_TTL_MS = 10_000;
/** One entry per collection; each is a count plus at most four poster references. */
const COLLECTION_PREVIEW_MAX_ENTRIES = 1024;

const collectionPreviews = new MemoryCache<CachedPreview>({
	ttlMs: COLLECTION_PREVIEW_TTL_MS,
	maxSize: COLLECTION_PREVIEW_MAX_ENTRIES,
	name: "collections.previews",
});

/** Counts and poster previews for the collections, read from the cache when a current entry exists. */
export async function loadMetadataPreviews(
	collectionIds: string[],
	tx?: DatabaseTransaction,
	options: { withCounts?: boolean; withPosters?: boolean } = {},
): Promise<Map<string, MetadataPreview>> {
	const withCounts = options.withCounts ?? true;
	const withPosters = options.withPosters ?? true;
	if (collectionIds.length === 0 || !(withCounts || withPosters)) return new Map<string, MetadataPreview>();

	// A transaction reads its own uncommitted writes, so its result must not reach the shared cache.
	if (!tx && withCounts && withPosters) return await loadCachedPreviews(collectionIds);

	return await queryPreviews(collectionIds, tx, { withCounts, withPosters });
}

/**
 * Full previews from the cache. Ids without a current entry are read in one query, and the
 * read is stamped with the epoch captured before it, so a write that flushes list bodies
 * while the query runs leaves the entry stale.
 */
async function loadCachedPreviews(collectionIds: string[]): Promise<Map<string, MetadataPreview>> {
	const epoch = responseBodyEpoch();
	const previews = new Map<string, MetadataPreview>();
	const missingIds: string[] = [];
	for (const id of collectionIds) {
		const cached = collectionPreviews.get(id);
		if (cached?.epoch === epoch) previews.set(id, cached);
		else missingIds.push(id);
	}
	if (missingIds.length === 0) return previews;

	const loaded = await queryPreviews(missingIds, undefined, { withCounts: true, withPosters: true });
	for (const [id, preview] of loaded) {
		const entry = { ...preview, epoch };
		collectionPreviews.set(id, entry);
		previews.set(id, entry);
	}

	return previews;
}

async function queryPreviews(
	collectionIds: string[],
	tx: DatabaseTransaction | undefined,
	{ withCounts, withPosters }: { withCounts: boolean; withPosters: boolean },
): Promise<Map<string, MetadataPreview>> {
	const client = databaseFactory.getClient({ tx });
	const rankedPosters = client
		.select({
			collectionId: schema.metadataCollections.collectionId,
			posterId: schema.metadataImages.imageId,
			posterUpdatedAt: schema.images.updatedAt,
			rn: sql<number>`ROW_NUMBER() OVER (PARTITION BY ${schema.metadataCollections.collectionId} ORDER BY MIN(${schema.metadataCollections.sortOrder}) ASC, ${schema.metadataImages.imageId} ASC)`.as(
				"rn",
			),
		})
		.from(schema.metadataCollections)
		.innerJoin(schema.metadataImages, posterImagesOn(schema.metadataCollections.metadataId))
		.innerJoin(schema.images, metadataImageOn)
		.where(inArray(schema.metadataCollections.collectionId, collectionIds))
		.groupBy(schema.metadataCollections.collectionId, schema.metadataImages.imageId)
		.as("ranked_posters");

	const [counts, posters] = await Promise.all([
		withCounts
			? client
					.select({
						collectionId: schema.metadataCollections.collectionId,
						// (metadata_id, collection_id) is the primary key, so metadata_id is
						// unique within a collection and COUNT(*) is exact; it also lets the
						// planner serve the group from the (collection_id, sort_order) index
						// instead of deduplicating ids per row.
						count: sql<number>`COUNT(*)`,
					})
					.from(schema.metadataCollections)
					.where(inArray(schema.metadataCollections.collectionId, collectionIds))
					.groupBy(schema.metadataCollections.collectionId)
			: [],
		withPosters
			? client
					.select({
						collectionId: rankedPosters.collectionId,
						posterId: rankedPosters.posterId,
						posterUpdatedAt: rankedPosters.posterUpdatedAt,
					})
					.from(rankedPosters)
					.where(lte(rankedPosters.rn, PREVIEW_POSTER_COUNT))
			: [],
	]);

	const countMap = toMap(
		counts,
		(c) => c.collectionId,
		(c) => c.count,
	);
	const posterMap = new Map<string, PosterImage[]>();
	for (const row of posters) {
		const existing = posterMap.get(row.collectionId) ?? [];
		if (existing.length < PREVIEW_POSTER_COUNT) {
			existing.push({ imageId: row.posterId, updatedAt: row.posterUpdatedAt });
			posterMap.set(row.collectionId, existing);
		}
	}

	const result = new Map<string, MetadataPreview>();
	for (const id of collectionIds) {
		result.set(id, {
			count: countMap.get(id) ?? 0,
			posterImages: posterMap.get(id) ?? [],
		});
	}

	return result;
}
