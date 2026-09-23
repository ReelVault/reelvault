import { t } from "elysia";
import { MetadataWithRelationSchema } from "./metadata.types";

export const DiscoverResponseSchema = t.Object({
	recentlyAddedMovies: t.Array(MetadataWithRelationSchema),
	recentlyAddedShows: t.Array(MetadataWithRelationSchema),
	recommendations: t.Array(MetadataWithRelationSchema),
	trending: t.Array(MetadataWithRelationSchema),
});

export type DiscoverResponse = typeof DiscoverResponseSchema.static;
