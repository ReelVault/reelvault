import { sql } from "drizzle-orm";
import { check, index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { DatabaseHelper } from "../utils/database-helper";
import { createProviderJunction } from "../utils/junction";
import { images } from "./images.schema";

export const people = sqliteTable(
	"people",
	{
		...DatabaseHelper.namedEntityImageColumns(() => images.id),

		name: text("name").notNull(),
		biography: text("biography"),
		gender: text("gender", { enum: ["male", "female", "other"] }),

		birthday: text("birthday"),
		knownCredits: integer("known_credits"),

		popularity: real("popularity").notNull().default(0),

		...DatabaseHelper.timestamps,
	},
	(t) => [
		index("people_name_idx").on(t.name),
		index("people_popularity_idx").on(t.popularity),
		...DatabaseHelper.namedEntityImageIndexes("people", t),
		check("people_gender_check", sql`${t.gender} IS NULL OR ${t.gender} IN ('male', 'female', 'other')`),
		check(
			"people_numeric_values_check",
			sql`(${t.knownCredits} IS NULL OR ${t.knownCredits} >= 0)
					AND ${t.popularity} >= 0`,
		),
	],
);

export const personProviders = createProviderJunction("person_providers", "personId", () => people.id);
