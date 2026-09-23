import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { DatabaseHelper } from "../utils/database-helper";
import { createProviderJunction, createRatingsJunction } from "../utils/junction";
import { images } from "./images.schema";
import { seasons } from "./seasons.schema";

export const episodes = sqliteTable(
	"episodes",
	{
		id: DatabaseHelper.id,
		stableKey: text("stable_key").notNull(),
		seasonId: DatabaseHelper.tableRef("season_id", () => seasons.id, { onDelete: "cascade" }),
		imageId: DatabaseHelper.nullableTableRef("image_id", () => images.id, { onDelete: "set null" }),

		episodeType: text("type", { enum: ["regular", "special"] })
			.notNull()
			.default("regular"),
		episodeNumber: integer("episode_number").notNull(),
		/** Provider-supplied absolute (anime-style) episode number; NULL when unknown. */
		absoluteNumber: integer("absolute_number"),
		title: text("title"),
		overview: text("overview"),
		airDate: text("air_date"),

		...DatabaseHelper.timestamps,
	},
	(t) => [
		uniqueIndex("episodes_unique").on(t.seasonId, t.episodeType, t.episodeNumber),
		uniqueIndex("episodes_stable_key_idx").on(t.stableKey),
		index("episodes_season_number_idx").on(t.seasonId, t.episodeNumber),
		index("episodes_image_idx").on(t.imageId),
		check("episodes_type_check", sql`${t.episodeType} IN ('regular', 'special')`),
		check("episodes_number_check", sql`${t.episodeNumber} >= 0`),
	],
);

export const episodeRatings = createRatingsJunction("episode_ratings", "episodeId", "episode_id", () => episodes.id);

export const episodeProviders = createProviderJunction("episode_providers", "episodeId", () => episodes.id);
