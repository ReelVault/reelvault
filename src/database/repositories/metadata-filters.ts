import type { MetadataFilters, MetadataSorting } from "@reelvault/sdk/common";
import type { SQL } from "drizzle-orm";
import { and, asc, desc, eq, exists, gt, gte, inArray, isNull, like, lt, lte, notExists, or, sql } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { databaseFactory } from "@/database/database";
import { schema } from "@/database/schema";
import type { DatabaseTransaction } from "@/database/types";
import { QueryFiltering } from "@/database/utils/filtering";
import type { QueryMap } from "@/database/utils/query-parser";
import { QuerySorting } from "@/database/utils/sorting";
import { LOW_CONFIDENCE_MATCH_SCORE } from "@/server.constants";
import { coerceBoolean, isFiniteNumber } from "@/utils/type.utils";

type MetadataRelationFilter = "library" | "company" | "genre" | "keyword" | "collection" | "cast" | "crew" | "file";
const ASCII_LETTER_PATTERN = /^[A-Z]$/;

/**
 * Title match filter shared by list filtering, the global-search fallback and
 * exact identity lookups. `contains` matches substrings, `exact` compares
 * verbatim, and `contains-or-id` additionally matches the metadata id.
 */
export function titleMatchFilter(term: string, mode: "contains" | "exact" | "contains-or-id" = "contains"): SQL {
	const title = schema.metadata.title;
	const originalTitle = schema.metadata.originalTitle;

	if (mode === "exact") return or(eq(title, term), eq(originalTitle, term)) ?? sql`1 = 0`;

	if (mode === "contains-or-id") {
		return or(like(title, `%${term}%`), like(originalTitle, `%${term}%`), like(schema.metadata.id, `%${term}%`)) ?? sql`1 = 0`;
	}

	return or(like(title, `%${term}%`), like(originalTitle, `%${term}%`)) ?? sql`1 = 0`;
}

function buildTitleSearchFilter(term: string): SQL {
	const searchTerm = term.trim();
	if (!searchTerm) return sql`1 = 0`;

	return titleMatchFilter(searchTerm, "contains-or-id");
}

/**
 * First-letter browse filter. A–Z match the title's first character (ASCII,
 * case-insensitive via LIKE); "#" matches any non-alphabetic start (digits,
 * symbols, and accents SQLite's ASCII-only UPPER does not fold). Falls back to
 * no filter for anything else. Mirrors the title resolution used by `sortTitle`.
 */
function buildStartsWithFilter(value: string): SQL | undefined {
	const letter = value.trim().toUpperCase();
	const titleColumn = sql`COALESCE(${schema.metadata.sortTitle}, ${schema.metadata.title}) COLLATE NOCASE`;
	if (letter === "#") {
		return sql`UPPER(SUBSTR(${titleColumn}, 1, 1)) NOT BETWEEN 'A' AND 'Z'`;
	}

	if (!ASCII_LETTER_PATTERN.test(letter)) return undefined;

	return sql`${titleColumn} LIKE ${`${letter}%`}`;
}

function buildRelationFilter(relation: MetadataRelationFilter, ids: string[] | undefined): SQL | undefined {
	if (relation === "library" || relation === "file") {
		return QueryFiltering.m2m(
			schema.metadata.id,
			ids,
			schema.mediaFiles,
			schema.mediaFiles.metadataId,
			relation === "library" ? schema.mediaFiles.libraryId : schema.mediaFiles.id,
		);
	}

	const relationTables = {
		company: [schema.metadataCompanies, schema.metadataCompanies.companyId],
		genre: [schema.metadataGenres, schema.metadataGenres.genreId],
		keyword: [schema.metadataKeywords, schema.metadataKeywords.keywordId],
		collection: [schema.metadataCollections, schema.metadataCollections.collectionId],
		cast: [schema.metadataCast, schema.metadataCast.personId],
		crew: [schema.metadataCrew, schema.metadataCrew.personId],
	} as const;
	const [junctionTable, junctionField] = relationTables[relation];

	return QueryFiltering.m2m(schema.metadata.id, ids, junctionTable, junctionTable.metadataId, junctionField);
}

/**
 * `EXISTS` predicate for a metadata junction row: the metadata has at least one
 * row in `table` whose `field` is in `ids`. Shared by filters and recommendations.
 */
export function metadataRelationExists(
	table: SQLiteTable & { metadataId: SQLiteColumn },
	field: SQLiteColumn,
	ids: readonly string[],
	tx?: DatabaseTransaction,
): SQL {
	return exists(
		databaseFactory
			.getClient({ tx })
			.select({ one: sql`1` })
			.from(table)
			.where(and(eq(table.metadataId, schema.metadata.id), inArray(field, [...ids]))),
	);
}

function buildPersonFilter(ids: string[] | undefined): SQL | undefined {
	if (!ids || ids.length === 0) return undefined;

	return or(
		metadataRelationExists(schema.metadataCast, schema.metadataCast.personId, ids),
		metadataRelationExists(schema.metadataCrew, schema.metadataCrew.personId, ids),
	);
}

function buildHasMediaFilesFilter(hasMediaFiles: boolean | string): SQL | undefined {
	const enabled = coerceBoolean(hasMediaFiles);
	const client = databaseFactory.getClient();
	const mediaFilesSubquery = client
		.select({ one: sql`1` })
		.from(schema.mediaFiles)
		.where(eq(schema.mediaFiles.metadataId, schema.metadata.id));

	return enabled ? exists(mediaFilesSubquery) : notExists(mediaFilesSubquery);
}

/** Any linked file at least `minutes` long (`min`) or at most `minutes` long (`max`). */
function buildDurationFilter(bound: "min" | "max", minutes: number): SQL | undefined {
	if (!isFiniteNumber(minutes) || minutes < 0) return undefined;

	const durationSeconds = Math.round(minutes * 60);
	const client = databaseFactory.getClient();
	const durationCondition =
		bound === "min" ? gte(schema.mediaFiles.duration, durationSeconds) : lte(schema.mediaFiles.duration, durationSeconds);

	return exists(
		client
			.select({ one: sql`1` })
			.from(schema.mediaFiles)
			.where(and(eq(schema.mediaFiles.metadataId, schema.metadata.id), durationCondition)),
	);
}

/**
 * Watched-state filter scoped to one profile. The service composes the value
 * as `profileId\0status` — the profile never comes from the client directly.
 * watched = any file fully watched; in_progress = started but not finished;
 * unwatched = no playback progress at all for this title.
 */
function buildWatchedStatusFilter(composite: string): SQL | undefined {
	const separator = composite.indexOf("\u0000");
	if (separator === -1) return undefined;

	const profileId = composite.slice(0, separator);
	const status = composite.slice(separator + 1);
	if (!profileId) return undefined;

	const client = databaseFactory.getClient();
	const baseWhere = [eq(schema.mediaFiles.metadataId, schema.metadata.id), eq(schema.playbackProgress.profileId, profileId)];

	if (status === "watched") {
		return exists(
			client
				.select({ one: sql`1` })
				.from(schema.mediaFiles)
				.innerJoin(schema.playbackProgress, eq(schema.playbackProgress.mediaFileId, schema.mediaFiles.id))
				.where(and(...baseWhere, eq(schema.playbackProgress.completed, true))),
		);
	}

	if (status === "in_progress") {
		return exists(
			client
				.select({ one: sql`1` })
				.from(schema.mediaFiles)
				.innerJoin(schema.playbackProgress, eq(schema.playbackProgress.mediaFileId, schema.mediaFiles.id))
				.where(and(...baseWhere, eq(schema.playbackProgress.completed, false), gt(schema.playbackProgress.position, 0))),
		);
	}

	if (status === "unwatched") {
		return notExists(
			client
				.select({ one: sql`1` })
				.from(schema.mediaFiles)
				.innerJoin(schema.playbackProgress, eq(schema.playbackProgress.mediaFileId, schema.mediaFiles.id))
				.where(and(...baseWhere)),
		);
	}

	return undefined;
}

/**
 * Profile rating filter (user_ratings 0..2; anything above 0 counts as
 * liked). Composite `profileId\0choice` injected by the service, as above.
 */
function buildUserRatingFilter(composite: string): SQL | undefined {
	const separator = composite.indexOf("\u0000");
	if (separator === -1) return undefined;

	const profileId = composite.slice(0, separator);
	const choice = composite.slice(separator + 1);
	if (!profileId) return undefined;

	const client = databaseFactory.getClient();
	const baseWhere = [eq(schema.userRatings.metadataId, schema.metadata.id), eq(schema.userRatings.profileId, profileId)];

	if (choice === "liked") {
		return exists(
			client
				.select({ one: sql`1` })
				.from(schema.userRatings)
				.where(and(...baseWhere, gt(schema.userRatings.rating, 0))),
		);
	}

	if (choice === "disliked") {
		return exists(
			client
				.select({ one: sql`1` })
				.from(schema.userRatings)
				.where(and(...baseWhere, eq(schema.userRatings.rating, 0))),
		);
	}

	if (choice === "unrated") {
		return notExists(
			client
				.select({ one: sql`1` })
				.from(schema.userRatings)
				.where(and(...baseWhere)),
		);
	}

	return undefined;
}

function buildLowConfidenceFilter(lowConfidence: boolean | string): SQL | undefined {
	const enabled = coerceBoolean(lowConfidence);
	if (!enabled) return undefined;

	return or(lt(schema.metadata.matchScore, LOW_CONFIDENCE_MATCH_SCORE), isNull(schema.metadata.matchScore));
}

export type MetadataRepositoryFilters = Omit<MetadataFilters, "watchedStatus" | "userRating"> & {
	watchedStatus?: string | undefined;
	userRating?: string | undefined;
};

export const metadataQueryMap: QueryMap<MetadataRepositoryFilters, MetadataSorting> = {
	filters: {
		title: (value: string) => buildTitleSearchFilter(value),
		startsWith: (value: string) => buildStartsWithFilter(value),
		type: (value: string) => QueryFiltering.eq(schema.metadata.type, value),
		yearFrom: (value: number) => QueryFiltering.gte(schema.metadata.releaseDate, `${value}-01-01`),
		yearTo: (value: number) => QueryFiltering.lte(schema.metadata.releaseDate, `${value}-12-31`),
		status: (value: string) => QueryFiltering.eq(schema.metadata.status, value),
		minMatchScore: (value: number) => QueryFiltering.gte(schema.metadata.matchScore, value),
		maxMatchScore: (value: number) => QueryFiltering.lte(schema.metadata.matchScore, value),
		lowConfidence: (value: boolean | string) => buildLowConfidenceFilter(value),
		metadataIds: (value: string) => QueryFiltering.inArray(schema.metadata.id, QueryFiltering.parseCommaSeparated(value)),
		libraryIds: (value: string) => buildRelationFilter("library", QueryFiltering.parseCommaSeparated(value)),
		companyIds: (value: string) => buildRelationFilter("company", QueryFiltering.parseCommaSeparated(value)),
		genreIds: (value: string) => buildRelationFilter("genre", QueryFiltering.parseCommaSeparated(value)),
		keywordIds: (value: string) => buildRelationFilter("keyword", QueryFiltering.parseCommaSeparated(value)),
		collectionIds: (value: string) => buildRelationFilter("collection", QueryFiltering.parseCommaSeparated(value)),
		castIds: (value: string) => buildRelationFilter("cast", QueryFiltering.parseCommaSeparated(value)),
		crewIds: (value: string) => buildRelationFilter("crew", QueryFiltering.parseCommaSeparated(value)),
		personIds: (value: string) => buildPersonFilter(QueryFiltering.parseCommaSeparated(value)),
		fileIds: (value: string) => buildRelationFilter("file", QueryFiltering.parseCommaSeparated(value)),
		hasMediaFiles: (value: boolean | string) => buildHasMediaFilesFilter(value),
		missingTranslation: (value: boolean | string) =>
			QueryFiltering.eq(schema.metadata.hasMissingTranslation, value === true || value === "true"),
		minDurationMinutes: (value: number) => buildDurationFilter("min", value),
		maxDurationMinutes: (value: number) => buildDurationFilter("max", value),
		watchedStatus: (value: string) => buildWatchedStatusFilter(value),
		userRating: (value: string) => buildUserRatingFilter(value),
	},
	orderBy: {
		title: schema.metadata.title,
		// Manual sort override; NULL falls back to the regular title so a
		// partially filled sortTitle never pushes entries to the end of the list.
		sortTitle: sql`COALESCE(${schema.metadata.sortTitle}, ${schema.metadata.title}) COLLATE NOCASE`,
		releaseDate: schema.metadata.releaseDate,
		budget: schema.metadata.budget,
		revenue: schema.metadata.revenue,
		popularity: schema.metadata.popularity,
		matchScore: schema.metadata.matchScore,
		createdAt: schema.metadata.createdAt,
		updatedAt: schema.metadata.updatedAt,
		collectionOrder: sql`(SELECT MIN(${schema.metadataCollections.sortOrder}) FROM ${schema.metadataCollections} WHERE ${schema.metadataCollections.metadataId} = ${schema.metadata.id})`,
		castOrder: sql`(SELECT CASE WHEN MIN(${schema.metadataCast.sortOrder}) < 0 THEN 9999 ELSE MIN(${schema.metadataCast.sortOrder}) END FROM ${schema.metadataCast} WHERE ${schema.metadataCast.metadataId} = ${schema.metadata.id})`,
	},
	defaults: { sortBy: "title", sortOrder: "asc" },
};

export function buildCollectionOrderBy(collectionIds: string | undefined, sortOrder: "asc" | "desc"): SQL {
	const ids = collectionIds ? QueryFiltering.parseCommaSeparated(collectionIds) : undefined;
	if (ids?.length === 1) {
		const orderExpression = sql`(
			SELECT ${schema.metadataCollections.sortOrder}
			FROM ${schema.metadataCollections}
			WHERE ${schema.metadataCollections.metadataId} = ${schema.metadata.id}
				AND ${schema.metadataCollections.collectionId} = ${ids[0]}
		)`;

		return sortOrder === "desc" ? desc(orderExpression) : asc(orderExpression);
	}

	return QuerySorting.apply(schema.metadata.releaseDate, sortOrder);
}
