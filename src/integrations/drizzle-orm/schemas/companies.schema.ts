import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { namedEntityImageColumns, namedEntityImageIndexes, timestampColumns } from "@/integrations/drizzle-orm/query/database-helper.utils";
import { createProviderJunction } from "@/integrations/drizzle-orm/utils/junction.utils";
import { images } from "./images.schema";

export const companies = sqliteTable(
	"companies",
	{
		...namedEntityImageColumns(() => images.id),

		name: text("name").notNull(),
		originalName: text("original_name"),

		...timestampColumns,
	},
	(t) => [uniqueIndex("companies_unique").on(t.name), ...namedEntityImageIndexes("companies", t)],
);

export const companyProviders = createProviderJunction("company_providers", "companyId", () => companies.id);
