import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { idColumn, timestampColumns } from "@/integrations/drizzle-orm/query/database-helper.utils";
import { createProviderJunction } from "@/integrations/drizzle-orm/utils/junction.utils";

export const collections = sqliteTable(
	"collections",
	{
		id: idColumn,
		stableKey: text("stable_key").notNull(),

		name: text("name").notNull(),

		sortMode: text("sort_mode", { enum: ["release_date", "manual", "alphabetical", "recently_added"] })
			.notNull()
			.default("release_date"),

		...timestampColumns,
	},
	(t) => [uniqueIndex("collections_unique").on(t.name), uniqueIndex("collections_stable_key_idx").on(t.stableKey)],
);

export const collectionProviders = createProviderJunction("collection_providers", "collectionId", () => collections.id);
