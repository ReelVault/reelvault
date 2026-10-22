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

/** Read enough raw poster rows to find four distinct images before falling back. */
const FAST_POSTER_SCAN = PREVIEW_POSTER_COUNT * 4;

interface FastPreviewRow {
	collectionId: string;
	count: number;
	posters: string | null;
}

interface ParsedPosters {
	posters: PosterImage[];
	rawCount: number;
}

function parsePosters(raw: string | null): ParsedPosters {
	const parsed: unknown = JSON.parse(raw ?? "[]");
	const rows: unknown[] = Array.isArray(parsed) ? parsed : [];

	const seen = new Set<string>();
	const posters: PosterImage[] = [];
	for (const row of rows) {
		if (typeof row !== "object" || row === null) continue;
		const record = row as { imageId?: unknown; updatedAt?: unknown };
		const imageId: unknown = record.imageId;
		const updatedAt: unknown = record.updatedAt;
		if (typeof imageId !== "string" || typeof updatedAt !== "number" || seen.has(imageId)) continue;

		seen.add(imageId);
		if (posters.length < PREVIEW_POSTER_COUNT) posters.push({ imageId, updatedAt: new Date(updatedAt * 1000) });
	}

	return { posters, rawCount: rows.length };
}

async function queryCountsOnly(collectionIds: string[], tx: DatabaseTransaction | undefined): Promise<Map<string, number>> {
	const client = databaseFactory.getClient({ tx });
	const rows = await client
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
		.groupBy(schema.metadataCollections.collectionId);

	return toMap(
		rows,
		(row) => row.collectionId,
		(row) => row.count,
	);
}

/**
 * Reads counts and the first `FAST_POSTER_SCAN` poster rows per collection.
 * A collection only needs the full distinct-image pass when that window is
 * full and still holds fewer than four distinct images.
 */
function queryFastPreviews(
	collectionIds: string[],
	tx: DatabaseTransaction | undefined,
	withCounts: boolean,
): { previews: Map<string, MetadataPreview>; needsFallback: string[] } {
	const client = databaseFactory.getClient({ tx });
	const countSelection = withCounts
		? sql`(SELECT COUNT(*) FROM ${schema.metadataCollections} mc WHERE mc.collection_id = c.id) AS count`
		: sql`0 AS count`;
	const rows = client.all<FastPreviewRow>(sql`
		SELECT c.id AS collectionId, ${countSelection}, (
			SELECT json_group_array(json_object('imageId', image_id, 'updatedAt', updated_at))
			FROM (
				SELECT mi.image_id AS image_id, i.updated_at AS updated_at
				FROM ${schema.metadataCollections} mc2
				JOIN ${schema.metadataImages} mi ON mi.metadata_id = mc2.metadata_id AND mi.image_type = 'poster'
				JOIN ${schema.images} i ON i.id = mi.image_id
				WHERE mc2.collection_id = c.id
				ORDER BY mc2.sort_order ASC, mi.image_id ASC
				LIMIT ${FAST_POSTER_SCAN}
			)
		) AS posters
		FROM ${schema.collections} c
		WHERE ${inArray(sql`c.id`, collectionIds)}
	`);

	const previews = new Map<string, MetadataPreview>();
	const needsFallback: string[] = [];
	for (const row of rows) {
		const parsed = parsePosters(row.posters);
		previews.set(row.collectionId, { count: row.count, posterImages: parsed.posters });
		// Fewer rows than the window means we already saw the whole collection.
		if (parsed.rawCount >= FAST_POSTER_SCAN && parsed.posters.length < PREVIEW_POSTER_COUNT) needsFallback.push(row.collectionId);
	}

	return { previews, needsFallback };
}

/** Exact distinct-image pass, used only when the fast window could not prove a complete result. */
async function queryRankedPosters(collectionIds: string[], tx: DatabaseTransaction | undefined): Promise<Map<string, PosterImage[]>> {
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

	const posters = await client
		.select({
			collectionId: rankedPosters.collectionId,
			posterId: rankedPosters.posterId,
			posterUpdatedAt: rankedPosters.posterUpdatedAt,
		})
		.from(rankedPosters)
		.where(lte(rankedPosters.rn, PREVIEW_POSTER_COUNT));

	const result = new Map<string, PosterImage[]>();
	for (const row of posters) {
		const existing = result.get(row.collectionId) ?? [];
		if (existing.length < PREVIEW_POSTER_COUNT) {
			existing.push({ imageId: row.posterId, updatedAt: row.posterUpdatedAt });
			result.set(row.collectionId, existing);
		}
	}

	return result;
}

async function queryPreviews(
	collectionIds: string[],
	tx: DatabaseTransaction | undefined,
	{ withCounts, withPosters }: { withCounts: boolean; withPosters: boolean },
): Promise<Map<string, MetadataPreview>> {
	if (!withPosters) {
		let counts = new Map<string, number>();
		if (withCounts) counts = await queryCountsOnly(collectionIds, tx);

		return new Map(collectionIds.map((id) => [id, { count: counts.get(id) ?? 0, posterImages: [] } satisfies MetadataPreview]));
	}

	const fast = queryFastPreviews(collectionIds, tx, withCounts);
	if (fast.needsFallback.length > 0) {
		const fallback = await queryRankedPosters(fast.needsFallback, tx);
		for (const [id, posterImages] of fallback) {
			const preview = fast.previews.get(id);
			if (preview) fast.previews.set(id, { ...preview, posterImages });
		}
	}

	return fast.previews;
}
