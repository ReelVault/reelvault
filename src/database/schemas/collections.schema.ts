import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { DatabaseHelper } from "../utils/database-helper";
import { createProviderJunction } from "../utils/junction";

export const collections = sqliteTable(
	"collections",
	{
		id: DatabaseHelper.id,
		stableKey: text("stable_key").notNull(),

		name: text("name").notNull(),

		sortMode: text("sort_mode", { enum: ["release_date", "manual", "alphabetical", "recently_added"] })
			.notNull()
			.default("release_date"),

		...DatabaseHelper.timestamps,
	},
	(t) => [uniqueIndex("collections_unique").on(t.name), uniqueIndex("collections_stable_key_idx").on(t.stableKey)],
);

export const collectionProviders = createProviderJunction("collection_providers", "collectionId", () => collections.id);
