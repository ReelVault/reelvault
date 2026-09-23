import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { DatabaseHelper } from "../utils/database-helper";
import { createProviderJunction } from "../utils/junction";

export const genres = sqliteTable(
	"genres",
	{
		id: DatabaseHelper.id,
		stableKey: text("stable_key").notNull(),

		name: text("name").notNull(),

		...DatabaseHelper.timestamps,
	},
	(t) => [uniqueIndex("genres_unique").on(t.name), uniqueIndex("genres_stable_key_idx").on(t.stableKey)],
);

export const genreProviders = createProviderJunction("genre_providers", "genreId", () => genres.id);
