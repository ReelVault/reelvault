import { providerEntityTypes } from "@reelvault/sdk/common";
import { sql } from "drizzle-orm";
import { check, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { DatabaseHelper } from "../utils/database-helper";

export const providers = sqliteTable(
	"providers",
	{
		id: DatabaseHelper.id,
		stableKey: text("stable_key").notNull(),

		name: text("name").notNull(),
		entityType: text("entity_type", { enum: providerEntityTypes }).notNull(),
		externalId: text("external_id").notNull(),

		...DatabaseHelper.timestamps,
	},
	(t) => [
		uniqueIndex("providers_unique").on(t.name, t.entityType, t.externalId),
		uniqueIndex("providers_stable_key_idx").on(t.stableKey),
		check(
			"providers_entity_type_check",
			sql`${t.entityType} IN ('movie', 'tv_show', 'collection', 'company', 'genre', 'keyword', 'person', 'season', 'episode')`,
		),
	],
);
