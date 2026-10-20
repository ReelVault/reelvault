import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { idColumn, timestampColumns } from "@/integrations/drizzle-orm/query/database-helper.utils";
import { createProviderJunction } from "@/integrations/drizzle-orm/utils/junction.utils";

export const keywords = sqliteTable(
	"keywords",
	{
		id: idColumn,
		stableKey: text("stable_key").notNull(),

		name: text("name").notNull(),

		...timestampColumns,
	},
	(t) => [uniqueIndex("keywords_unique").on(t.name), uniqueIndex("keywords_stable_key_idx").on(t.stableKey)],
);

export const keywordProviders = createProviderJunction("keyword_providers", "keywordId", () => keywords.id);
