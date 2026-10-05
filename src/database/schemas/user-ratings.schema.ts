import { sql } from "drizzle-orm";
import { check, integer } from "drizzle-orm/sqlite-core";
import { createProfileMetadataLink } from "../utils/junction";
import { metadata } from "./metadata.schema";
import { profiles } from "./profiles.schema";

export const userRatings = createProfileMetadataLink(
	"user_ratings",
	{ profileId: () => profiles.id, metadataId: () => metadata.id },
	{ rating: integer("rating").notNull() }, // e.g., 1-10 or 1 for like, 0 for dislike
	(t) => [check("user_ratings_value_check", sql`${t.rating} BETWEEN 0 AND 2`)],
);
