import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, uniqueIndex } from "drizzle-orm/sqlite-core";
import { DatabaseHelper } from "../utils/database-helper";
import { metadata } from "./metadata.schema";
import { profiles } from "./profiles.schema";

export const userRatings = sqliteTable(
	"user_ratings",
	{
		id: DatabaseHelper.id,
		profileId: DatabaseHelper.tableRef("profile_id", () => profiles.id, { onDelete: "cascade" }),
		metadataId: DatabaseHelper.tableRef("metadata_id", () => metadata.id, { onDelete: "cascade" }),

		rating: integer("rating").notNull(), // e.g., 1-10 or 1 for like, 0 for dislike

		...DatabaseHelper.timestamps,
	},
	(t) => [
		uniqueIndex("user_ratings_unique").on(t.profileId, t.metadataId),
		index("user_ratings_metadata_idx").on(t.metadataId),
		index("user_ratings_profile_created_idx").on(t.profileId, t.createdAt),
		check("user_ratings_value_check", sql`${t.rating} BETWEEN 0 AND 2`),
	],
);
