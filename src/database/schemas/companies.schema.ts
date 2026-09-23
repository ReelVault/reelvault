import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { DatabaseHelper } from "../utils/database-helper";
import { createProviderJunction } from "../utils/junction";
import { images } from "./images.schema";

export const companies = sqliteTable(
	"companies",
	{
		id: DatabaseHelper.id,
		stableKey: text("stable_key").notNull(),
		imageId: DatabaseHelper.nullableTableRef("image_id", () => images.id, { onDelete: "set null" }),

		name: text("name").notNull(),
		originalName: text("original_name"),

		...DatabaseHelper.timestamps,
	},
	(t) => [
		uniqueIndex("companies_unique").on(t.name),
		uniqueIndex("companies_stable_key_idx").on(t.stableKey),
		index("companies_image_idx").on(t.imageId),
	],
);

export const companyProviders = createProviderJunction("company_providers", "companyId", () => companies.id);
