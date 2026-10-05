import type { GlobalSearchResponse } from "@reelvault/sdk/common";
import { and, desc, eq, inArray, like, sql } from "drizzle-orm";
import { databaseFactory } from "@/database/database";
import { schema } from "@/database/schema";
import { toMap, trimAndFilter } from "@/utils/array.utils";
import { fuzzyTitleDistance } from "@/utils/media-match.utils";
import { titleMatchFilter } from "./metadata-filters";

const WHITESPACE_RE = /\s+/;

/**
 * FTS5 MATCH query from user input: every whitespace token becomes a
 * double-quoted prefix term ("sta" "trek"*) — implicit AND, prefix on each
 * token. Quoting defuses FTS5 syntax characters in the input. Empty string
 * means the term produced no usable token.
 */
function ftsMatchQuery(term: string): string {
	const tokens = trimAndFilter(term.split(WHITESPACE_RE)).map((token) => `"${token.replaceAll('"', '""')}"*`);

	return tokens.join(" ");
}

/** Prefix-first LIKE scan over a small named lookup table (collections, genres). */
function findNamedMatches(
	client: ReturnType<typeof databaseFactory.getClient>,
	table: typeof schema.collections | typeof schema.genres,
	containsPattern: string,
	prefixPattern: string,
	limit: number,
) {
	return client
		.select({ id: table.id, name: table.name })
		.from(table)
		.where(like(table.name, containsPattern))
		.orderBy(sql`CASE WHEN ${table.name} LIKE ${prefixPattern} THEN 0 ELSE 1 END`, table.name)
		.limit(limit);
}

interface PosterInfo {
	imageId: string;
	updatedAt: Date;
}

function posterMap<TRow extends { imageId: string; imageUpdatedAt: Date }>(
	rows: TRow[],
	keyOf: (row: TRow) => string,
): Map<string, PosterInfo> {
	return toMap(rows, keyOf, (row) => ({ imageId: row.imageId, updatedAt: row.imageUpdatedAt }));
}

function attachPosters<T extends { id: string }>(items: T[], posters: Map<string, PosterInfo>) {
	return items.map((item) => {
		const poster = posters.get(item.id);

		return {
			...item,
			imageId: poster?.imageId ?? null,
			imageUpdatedAt: poster?.updatedAt ?? null,
		};
	});
}

export async function searchGlobal({ term, limit }: { term: string; limit: number }): Promise<GlobalSearchResponse> {
	const searchTerm = term.trim();
	if (!searchTerm) return { titles: [], people: [], collections: [], genres: [] };

	const client = databaseFactory.getClient();
	const prefixPattern = `${searchTerm}%`;
	const containsPattern = `%${searchTerm}%`;
	// Titles and people go through the trigger-maintained FTS5 index instead
	// of leading-wildcard LIKE scans per keystroke. Small lookup tables
	// (collections, genres) keep the LIKE scan.
	const metadataMatch = ftsMatchQuery(searchTerm);

	const rawTitles = metadataMatch
		? client.all<{ id: string; title: string; type: "movie" | "tv_show" }>(sql`
				SELECT m.id AS id, m.title AS title, m.type AS type
				FROM metadata_fts
				JOIN metadata m ON m.id = metadata_fts.metadata_id
				WHERE metadata_fts MATCH ${metadataMatch}
				ORDER BY rank
				LIMIT ${limit}
			`)
		: [];
	// Typo tolerance: when the prefix index leaves results sparse, a bounded
	// fuzzy pass over close candidates fills the gap (ranked by edit distance,
	// appended after the exact matches).
	const fuzzyTitles = rawTitles.length < limit ? await fuzzyTitleSearch(client, searchTerm, limit, rawTitles) : [];
	const peopleRows = metadataMatch
		? client.all<{ id: string; name: string; imageId: string | null; imageUpdatedAt: number | null }>(sql`
				SELECT p.id AS id, p.name AS name, p.image_id AS imageId, i.updated_at AS imageUpdatedAt
				FROM people_fts
				JOIN people p ON p.id = people_fts.person_id
				LEFT JOIN images i ON i.id = p.image_id
				WHERE people_fts MATCH ${metadataMatch}
				ORDER BY rank
				LIMIT ${limit}
			`)
		: [];
	// Raw SQL bypasses drizzle's column mappers — updated_at is stored as unix seconds.
	const people = peopleRows.map((row) => ({
		...row,
		imageUpdatedAt: row.imageUpdatedAt != null ? new Date(row.imageUpdatedAt * 1000) : null,
	}));
	const [rawCollections, genres] = await Promise.all([
		findNamedMatches(client, schema.collections, containsPattern, prefixPattern, limit),
		findNamedMatches(client, schema.genres, containsPattern, prefixPattern, limit),
	]);

	const matchedTitles = [...rawTitles, ...fuzzyTitles];
	const [titlePosters, collectionPosters] = await Promise.all([
		matchedTitles.length > 0
			? client
					.select({
						metadataId: schema.metadataImages.metadataId,
						imageId: schema.metadataImages.imageId,
						imageUpdatedAt: schema.images.updatedAt,
					})
					.from(schema.metadataImages)
					.innerJoin(schema.images, eq(schema.images.id, schema.metadataImages.imageId))
					.where(
						and(
							inArray(
								schema.metadataImages.metadataId,
								matchedTitles.map((t) => t.id),
							),
							eq(schema.metadataImages.imageType, "poster"),
						),
					)
			: [],
		rawCollections.length > 0
			? client
					.select({
						collectionId: schema.metadataCollections.collectionId,
						imageId: schema.metadataImages.imageId,
						imageUpdatedAt: schema.images.updatedAt,
					})
					.from(schema.metadataCollections)
					.innerJoin(
						schema.metadataImages,
						and(eq(schema.metadataImages.metadataId, schema.metadataCollections.metadataId), eq(schema.metadataImages.imageType, "poster")),
					)
					.innerJoin(schema.images, eq(schema.images.id, schema.metadataImages.imageId))
					.where(
						inArray(
							schema.metadataCollections.collectionId,
							rawCollections.map((c) => c.id),
						),
					)
			: [],
	]);

	const titlePosterMap = posterMap(titlePosters, (row) => row.metadataId);
	const collectionPosterMap = posterMap(collectionPosters, (row) => row.collectionId);

	const titles = attachPosters(matchedTitles, titlePosterMap);
	const collections = attachPosters(rawCollections, collectionPosterMap);

	return { titles, people, collections, genres };
}

/**
 * Typo-tolerant fallback for the FTS5 prefix search. Candidates come from a
 * bounded LIKE over the leading characters of the longest query token (a
 * shared prefix is what most typos keep), then get ranked in JS by edit
 * distance against the title words. Anything beyond the distance budget is
 * dropped; the budget scales with token length: max(2, len/4).
 */
async function fuzzyTitleSearch(
	client: ReturnType<typeof databaseFactory.getClient>,
	searchTerm: string,
	limit: number,
	exactMatches: ReadonlyArray<{ id: string }>,
): Promise<Array<{ id: string; title: string; type: "movie" | "tv_show" }>> {
	const rawTokens = searchTerm.toLowerCase().split(WHITESPACE_RE);
	let longestToken: string | undefined;
	for (const t of rawTokens) {
		if (t.length >= 3 && (!longestToken || t.length > longestToken.length)) {
			longestToken = t;
		}
	}

	const token = longestToken;
	if (!token) return [];

	const candidates = await client
		.select({ id: schema.metadata.id, title: schema.metadata.title, type: schema.metadata.type })
		.from(schema.metadata)
		.where(titleMatchFilter(token.slice(0, 3), "contains"))
		.orderBy(desc(schema.metadata.popularity))
		.limit(400);

	const maxDistance = Math.max(2, Math.floor(token.length / 4));
	const exactIds = new Set(exactMatches.map((match) => match.id));
	const scored = candidates.reduce<Array<(typeof candidates)[number] & { distance: number }>>((acc, candidate) => {
		const distance = fuzzyTitleDistance(token, candidate.title, maxDistance);
		if (distance !== null && !exactIds.has(candidate.id)) {
			acc.push({ ...candidate, distance });
		}

		return acc;
	}, []);

	scored.sort((left, right) => left.distance - right.distance);

	return scored.slice(0, limit).map(({ id, title, type }) => ({ id, title, type }));
}
