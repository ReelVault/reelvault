import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { DatabaseHelper } from "../utils/database-helper";
import { createProviderJunction } from "../utils/junction";
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
