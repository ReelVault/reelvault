import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { DatabaseHelper } from "../utils/database-helper";
import { createProviderJunction, createRatingsJunction } from "../utils/junction";
import { collections } from "./collections.schema";
import { companies } from "./companies.schema";
import { genres } from "./genres.schema";
import { images } from "./images.schema";
import { keywords } from "./keywords.schema";
import { people } from "./people.schema";

export const metadata = sqliteTable(
	"metadata",
	{
		id: DatabaseHelper.id,
		stableKey: text("stable_key").notNull(),
		/** Metadata provider id used as the preferred refresh source. */
		primaryProviderId: text("primary_provider_id"),

		title: text("title").notNull(),
		/** Manual sort override — never written by metadata providers; falls back to `title` when NULL. */
		sortTitle: text("sort_title"),
		/** Episode numbering display/order mode for this series — admin-only, never provider-written. */
		numberingMode: text("numbering_mode", { enum: ["seasonal", "absolute"] }),
		originalTitle: text("original_title"),
		overview: text("overview"),
		tagline: text("tagline"),

		type: text("type", { enum: ["movie", "tv_show"] }).notNull(),
		status: text("status"),

		releaseDate: text("release_date").notNull(), // ISO
		originCountry: text("origin_country"),

		budget: integer("budget"), // USD
		revenue: integer("revenue"), // USD

		popularity: real("popularity").notNull().default(0),
		matchScore: real("match_score"),
		hasMissingTranslation: integer("has_missing_translation", { mode: "boolean" }).notNull().default(false),

		...DatabaseHelper.timestamps,
	},
	(t) => [
		uniqueIndex("metadata_unique").on(t.title, t.type, t.releaseDate),
		index("metadata_type_created_idx").on(t.type, t.createdAt),
		uniqueIndex("metadata_stable_key_idx").on(t.stableKey),
		index("metadata_created_id_idx").on(t.createdAt, t.id),
		index("metadata_updated_at_idx").on(t.updatedAt),
		index("metadata_popularity_created_idx").on(t.popularity, t.createdAt),
		index("metadata_type_popularity_created_idx").on(t.type, t.popularity, t.createdAt),
		index("metadata_type_title_idx").on(t.type, t.title),
		index("metadata_type_release_date_idx").on(t.type, t.releaseDate),
		index("metadata_title_idx").on(t.title),
		// Browse-by-letter and sortTitle ordering use COALESCE(sort_title, title)
		// COLLATE NOCASE — only an expression index can serve those scans/sorts.
		index("metadata_sort_title_nocase_idx").on(sql`COALESCE(${t.sortTitle}, ${t.title}) COLLATE NOCASE`),
		index("metadata_match_score_idx").on(t.matchScore),
		index("metadata_missing_translation_idx").on(t.hasMissingTranslation),
		// `findPage` always appends the primary key as an ORDER BY tiebreaker
		// (`ORDER BY <sortKey>, id`). Single-column indexes cannot satisfy the
		// second term, so SQLite fell back to `USE TEMP B-TREE FOR LAST TERM OF
		// ORDER BY` — sorting the entire filtered set before LIMIT/OFFSET, which
		// grew with catalog size and offset. These composites let the index cover
		// the full ORDER BY, so LIMIT/OFFSET walks the index directly.
		index("metadata_title_id_idx").on(t.title, t.id),
		index("metadata_sort_title_nocase_id_idx").on(sql`COALESCE(${t.sortTitle}, ${t.title}) COLLATE NOCASE`, t.id),
		index("metadata_release_date_id_idx").on(t.releaseDate, t.id),
		index("metadata_popularity_id_idx").on(t.popularity, t.id),
		index("metadata_match_score_id_idx").on(t.matchScore, t.id),
		index("metadata_updated_at_id_idx").on(t.updatedAt, t.id),
		check("metadata_type_check", sql`${t.type} IN ('movie', 'tv_show')`),
		check(
			"metadata_numeric_values_check",
			sql`(${t.budget} IS NULL OR ${t.budget} >= 0)
					AND (${t.revenue} IS NULL OR ${t.revenue} >= 0)
					AND ${t.popularity} >= 0`,
		),
	],
);

export const metadataCollections = sqliteTable(
	"metadata_collections",
	{
		metadataId: DatabaseHelper.tableRef("metadata_id", () => metadata.id, { onDelete: "cascade" }),
		collectionId: DatabaseHelper.tableRef("collection_id", () => collections.id, { onDelete: "cascade" }),

		sortOrder: integer("sort_order").notNull().default(0),
	},
	(t) => [
		primaryKey({ columns: [t.metadataId, t.collectionId] }),
		index("metadata_collections_collection_idx").on(t.collectionId),
		index("metadata_collections_collection_sort_idx").on(t.collectionId, t.sortOrder),
	],
);

export const metadataCompanies = sqliteTable(
	"metadata_companies",
	{
		metadataId: DatabaseHelper.tableRef("metadata_id", () => metadata.id, { onDelete: "cascade" }),
		companyId: DatabaseHelper.tableRef("company_id", () => companies.id, { onDelete: "cascade" }),
	},
	(t) => [primaryKey({ columns: [t.metadataId, t.companyId] }), index("metadata_companies_company_idx").on(t.companyId)],
);

export const metadataGenres = sqliteTable(
	"metadata_genres",
	{
		metadataId: DatabaseHelper.tableRef("metadata_id", () => metadata.id, { onDelete: "cascade" }),
		genreId: DatabaseHelper.tableRef("genre_id", () => genres.id, { onDelete: "cascade" }),
	},
	(t) => [primaryKey({ columns: [t.metadataId, t.genreId] }), index("metadata_genres_genre_idx").on(t.genreId)],
);

export const metadataKeywords = sqliteTable(
	"metadata_keywords",
	{
		metadataId: DatabaseHelper.tableRef("metadata_id", () => metadata.id, { onDelete: "cascade" }),
		keywordId: DatabaseHelper.tableRef("keyword_id", () => keywords.id, { onDelete: "cascade" }),
	},
	(t) => [primaryKey({ columns: [t.metadataId, t.keywordId] }), index("metadata_keywords_keyword_idx").on(t.keywordId)],
);

export const metadataCast = sqliteTable(
	"metadata_cast",
	{
		metadataId: DatabaseHelper.tableRef("metadata_id", () => metadata.id, { onDelete: "cascade" }),
		personId: DatabaseHelper.tableRef("person_id", () => people.id, { onDelete: "cascade" }),

		// Data
		role: text("role").notNull(),
		character: text("character"),
		sortOrder: integer("sort_order").notNull().default(-1),
	},
	(t) => [
		primaryKey({ columns: [t.metadataId, t.personId, t.role] }),
		index("metadata_cast_person_idx").on(t.personId),
		check("metadata_cast_sort_order_check", sql`${t.sortOrder} IS NULL OR ${t.sortOrder} >= -1`),
	],
);

export const metadataCrew = sqliteTable(
	"metadata_crew",
	{
		metadataId: DatabaseHelper.tableRef("metadata_id", () => metadata.id, { onDelete: "cascade" }),
		personId: DatabaseHelper.tableRef("person_id", () => people.id, { onDelete: "cascade" }),

		job: text("job").notNull(),
		department: text("department").notNull(),
	},
	(t) => [primaryKey({ columns: [t.metadataId, t.personId, t.job] }), index("metadata_crew_person_idx").on(t.personId)],
);

export const metadataImages = sqliteTable(
	"metadata_images",
	{
		metadataId: DatabaseHelper.tableRef("metadata_id", () => metadata.id, { onDelete: "cascade" }),
		imageId: DatabaseHelper.tableRef("image_id", () => images.id, { onDelete: "cascade" }),

		imageType: text("image_type", {
			enum: ["poster", "backdrop", "logo", "thumbnail"],
		}).notNull(),
	},
	(t) => [primaryKey({ columns: [t.metadataId, t.imageType, t.imageId] }), index("metadata_images_image_idx").on(t.imageId)],
);

export const metadataRatings = createRatingsJunction("metadata_ratings", "metadataId", "metadata_id", () => metadata.id);

export const metadataProviders = createProviderJunction("metadata_providers", "metadataId", () => metadata.id);

export const metadataLockedFields = sqliteTable(
	"metadata_locked_fields",
	{
		metadataId: DatabaseHelper.tableRef("metadata_id", () => metadata.id, { onDelete: "cascade" }),
		field: text("field").notNull(),
	},
	(t) => [primaryKey({ columns: [t.metadataId, t.field] })],
);
