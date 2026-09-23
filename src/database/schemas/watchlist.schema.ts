import { index, sqliteTable, uniqueIndex } from "drizzle-orm/sqlite-core";
import { DatabaseHelper } from "../utils/database-helper";
import { metadata } from "./metadata.schema";
import { profiles } from "./profiles.schema";

export const watchlist = sqliteTable(
	"watchlist",
	{
		id: DatabaseHelper.id,
		profileId: DatabaseHelper.tableRef("profile_id", () => profiles.id, { onDelete: "cascade" }),
		metadataId: DatabaseHelper.tableRef("metadata_id", () => metadata.id, { onDelete: "cascade" }),

		...DatabaseHelper.timestamps,
	},
	(t) => [
		uniqueIndex("watchlist_unique").on(t.profileId, t.metadataId),
		index("watchlist_metadata_idx").on(t.metadataId),
		index("watchlist_profile_created_idx").on(t.profileId, t.createdAt),
	],
);
