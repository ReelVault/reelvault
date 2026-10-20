import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { idColumn, nullableTableRef, tableRef, timestampColumns } from "@/integrations/drizzle-orm/query/database-helper.utils";
import { createProviderJunction, createRatingsJunction } from "@/integrations/drizzle-orm/utils/junction.utils";
import { images } from "./images.schema";
import { metadata } from "./metadata.schema";

export const seasons = sqliteTable(
	"seasons",
	{
		id: idColumn,
		stableKey: text("stable_key").notNull(),
		metadataId: tableRef("metadata_id", () => metadata.id, { onDelete: "cascade" }),
		imageId: nullableTableRef("image_id", () => images.id, { onDelete: "set null" }),

		seasonNumber: integer("season_number").notNull(),
		name: text("name"),
		overview: text("overview"),

		airDate: text("air_date"),
		status: text("status"),

		...timestampColumns,
	},
	(t) => [
		uniqueIndex("seasons_unique").on(t.metadataId, t.seasonNumber),
		uniqueIndex("seasons_stable_key_idx").on(t.stableKey),
		index("seasons_image_idx").on(t.imageId),
		// The list page sorts by season_number and appends the id as a tiebreaker;
		// the composite covers both.
		index("seasons_number_id_idx").on(t.seasonNumber, t.id),
		check("seasons_number_check", sql`${t.seasonNumber} >= 0`),
	],
);

export const seasonRatings = createRatingsJunction("season_ratings", "seasonId", "season_id", () => seasons.id);

export const seasonProviders = createProviderJunction("season_providers", "seasonId", () => seasons.id);
