import { safeParseJson } from "@/utils/file.utils";
import {
	castDateKeys,
	castKeys,
	collectionDateKeys,
	collectionKeys,
	companyDateKeys,
	companyKeys,
	crewDateKeys,
	crewKeys,
	genreDateKeys,
	genreKeys,
	imageDateKeys,
	imageKeys,
	imagePayloadKeys,
	keywordDateKeys,
	keywordKeys,
	personDateKeys,
	personKeys,
	providerDateKeys,
	providerKeys,
	ratingDateKeys,
	ratingKeys,
} from "./columns.constants";
import type { DetailRelationsRow, MetadataRelationData, RelationItem } from "./relations.types";

/** Fresh empty relation payload — callers mutate the arrays, so never share one instance. */
export function emptyRelationData(): MetadataRelationData {
	return {
		collections: [],
		companies: [],
		genres: [],
		keywords: [],
		cast: [],
		crew: [],
		images: [],
		rating: { avgScore: 0, scores: [] },
		providers: [],
		lockedFields: [],
	};
}

/** SQLite JSON returns raw seconds for timestamp columns; drizzle returns Date. */
function isRecordValue(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Narrows a JSON payload item to a relation DTO shape. The SQL builder emits
 * exactly the columns in `keys`; `_shape` anchors the type parameter to the
 * caller's DTO type.
 */
function isRelationItem<T extends object>(item: unknown, keys: readonly string[], _shape?: T): item is T {
	if (!isRecordValue(item)) return false;

	return keys.every((key) => key in item);
}

function reviveDateColumns(item: unknown, keys: readonly string[]): void {
	if (keys.length === 0 || !isRecordValue(item)) return;

	for (const key of keys) {
		const value = item[key];
		if (typeof value === "number") item[key] = new Date(value * 1000);
	}
}

/** Relation payloads arrive as JSON strings; the SQL builder fixes the shape. */
function parsePayload<T extends object>(payload: string, keys: readonly string[], dateKeys: readonly string[]): T[] {
	const parsed = safeParseJson(payload);
	if (!Array.isArray(parsed)) return [];

	const items: T[] = [];
	for (const item of parsed) {
		if (!isRelationItem<T>(item, keys)) continue;

		reviveDateColumns(item, dateKeys);
		items.push(item);
	}

	return items;
}

function parseStringPayload(payload: string): string[] {
	const parsed = safeParseJson(payload);

	return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}

/** Payload items with a nested `data` object (cast, crew, images) revive both levels. */
function parseNestedPayload<T extends object>(
	payload: string,
	keys: readonly string[],
	dataKeys: readonly string[],
	outerDateKeys: readonly string[],
	dataDateKeys: readonly string[],
): T[] {
	const parsed = safeParseJson(payload);
	if (!Array.isArray(parsed)) return [];

	const items: T[] = [];
	for (const item of parsed) {
		if (!isRelationItem<T>(item, keys)) continue;

		reviveDateColumns(item, outerDateKeys);
		const data = isRecordValue(item) ? item.data : undefined;
		if (isRelationItem(data, dataKeys)) reviveDateColumns(data, dataDateKeys);
		items.push(item);
	}

	return items;
}

export function applyDetailRelations(target: MetadataRelationData, row: DetailRelationsRow): void {
	target.collections.push(...parsePayload<RelationItem<"collections">>(row.collections, collectionKeys, collectionDateKeys));
	target.companies.push(...parsePayload<RelationItem<"companies">>(row.companies, companyKeys, companyDateKeys));
	target.genres.push(...parsePayload<RelationItem<"genres">>(row.genres, genreKeys, genreDateKeys));
	target.keywords.push(...parsePayload<RelationItem<"keywords">>(row.keywords, keywordKeys, keywordDateKeys));
	target.cast.push(...parseNestedPayload<RelationItem<"cast">>(row.cast, castKeys, personKeys, castDateKeys, personDateKeys));
	target.crew.push(...parseNestedPayload<RelationItem<"crew">>(row.crew, crewKeys, personKeys, crewDateKeys, personDateKeys));
	target.images.push(...parseNestedPayload<RelationItem<"images">>(row.images, imagePayloadKeys, imageKeys, [], imageDateKeys));
	target.rating.scores.push(...parsePayload<MetadataRelationData["rating"]["scores"][number]>(row.rating, ratingKeys, ratingDateKeys));
	target.providers.push(...parsePayload<RelationItem<"providers">>(row.providers, providerKeys, providerDateKeys));
	target.lockedFields.push(...parseStringPayload(row.lockedFields));
}
