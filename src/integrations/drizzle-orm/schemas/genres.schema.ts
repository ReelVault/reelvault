import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { idColumn, timestampColumns } from "@/integrations/drizzle-orm/query/database-helper.utils";
import { createProviderJunction } from "@/integrations/drizzle-orm/utils/junction.utils";

export const genres = sqliteTable(
	"genres",
	{
		id: idColumn,
		stableKey: text("stable_key").notNull(),

		name: text("name").notNull(),

		...timestampColumns,
	},
	(t) => [uniqueIndex("genres_unique").on(t.name), uniqueIndex("genres_stable_key_idx").on(t.stableKey)],
);

export const genreProviders = createProviderJunction("genre_providers", "genreId", () => genres.id);
