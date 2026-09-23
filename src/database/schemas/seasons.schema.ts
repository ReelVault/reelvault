import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { DatabaseHelper } from "../utils/database-helper";
import { createProviderJunction, createRatingsJunction } from "../utils/junction";
import { images } from "./images.schema";
import { metadata } from "./metadata.schema";

export const seasons = sqliteTable(
	"seasons",
	{
		id: DatabaseHelper.id,
		stableKey: text("stable_key").notNull(),
		metadataId: DatabaseHelper.tableRef("metadata_id", () => metadata.id, { onDelete: "cascade" }),
		imageId: DatabaseHelper.nullableTableRef("image_id", () => images.id, { onDelete: "set null" }),

		seasonNumber: integer("season_number").notNull(),
		name: text("name"),
		overview: text("overview"),

		airDate: text("air_date"),
		status: text("status"),

		...DatabaseHelper.timestamps,
	},
	(t) => [
		uniqueIndex("seasons_unique").on(t.metadataId, t.seasonNumber),
		uniqueIndex("seasons_stable_key_idx").on(t.stableKey),
		index("seasons_image_idx").on(t.imageId),
		check("seasons_number_check", sql`${t.seasonNumber} >= 0`),
	],
);

export const seasonRatings = createRatingsJunction("season_ratings", "seasonId", "season_id", () => seasons.id);

export const seasonProviders = createProviderJunction("season_providers", "seasonId", () => seasons.id);
