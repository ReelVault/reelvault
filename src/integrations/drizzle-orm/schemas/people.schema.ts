import { sql } from "drizzle-orm";
import { check, index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { namedEntityImageColumns, namedEntityImageIndexes, timestampColumns } from "@/integrations/drizzle-orm/query/database-helper.utils";
import { createProviderJunction } from "@/integrations/drizzle-orm/utils/junction.utils";
import { images } from "./images.schema";

export const people = sqliteTable(
	"people",
	{
		...namedEntityImageColumns(() => images.id),

		name: text("name").notNull(),
		biography: text("biography"),
		gender: text("gender", { enum: ["male", "female", "other"] }),

		birthday: text("birthday"),
		knownCredits: integer("known_credits"),

		popularity: real("popularity").notNull().default(0),

		...timestampColumns,
	},
	(t) => [
		index("people_name_idx").on(t.name),
		index("people_popularity_idx").on(t.popularity),
		// The list page sorts by name and appends the id as a tiebreaker; the
		// composite covers both.
		index("people_name_id_idx").on(t.name, t.id),
		...namedEntityImageIndexes("people", t),
		check("people_gender_check", sql`${t.gender} IS NULL OR ${t.gender} IN ('male', 'female', 'other')`),
		check(
			"people_numeric_values_check",
			sql`(${t.knownCredits} IS NULL OR ${t.knownCredits} >= 0)
					AND ${t.popularity} >= 0`,
		),
	],
);

export const personProviders = createProviderJunction("person_providers", "personId", () => people.id);
