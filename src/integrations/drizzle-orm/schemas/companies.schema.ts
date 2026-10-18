import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { DatabaseHelper } from "@/integrations/drizzle-orm/query/database-helper.utils";
import { createProviderJunction } from "@/integrations/drizzle-orm/utils/junction.utils";
import { images } from "./images.schema";

export const companies = sqliteTable(
	"companies",
	{
		...DatabaseHelper.namedEntityImageColumns(() => images.id),

		name: text("name").notNull(),
		originalName: text("original_name"),

		...DatabaseHelper.timestamps,
	},
	(t) => [uniqueIndex("companies_unique").on(t.name), ...DatabaseHelper.namedEntityImageIndexes("companies", t)],
);

export const companyProviders = createProviderJunction("company_providers", "companyId", () => companies.id);
