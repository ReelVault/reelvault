import { t } from "elysia";
import { EntitySchema } from "./schema-utils";

export const UserRatingSchema = EntitySchema(
	t.Object({ id: t.String(), profileId: t.String(), metadataId: t.String(), rating: t.Integer({ minimum: 0, maximum: 2 }) }),
);

export type UserRating = typeof UserRatingSchema.static;

export const CreateUserRatingSchema = t.Object({
	metadataId: t.String(),
	rating: t.Numeric({ minimum: 0, maximum: 2 }),
});

export type CreateUserRatingRequest = typeof CreateUserRatingSchema.static;

export const UpdateUserRatingSchema = t.Partial(CreateUserRatingSchema);

export const UserRatingFiltersSchema = t.Object({
	profileId: t.Optional(t.String()),
	metadataId: t.Optional(t.String()),
	rating: t.Optional(t.Numeric()),
});

export type UserRatingFilters = typeof UserRatingFiltersSchema.static;

export const UserRatingSortingSchema = t.Object({
	sortBy: t.Optional(t.Union([t.Literal("rating"), t.Literal("createdAt"), t.Literal("updatedAt")])),
});

export type UserRatingSorting = typeof UserRatingSortingSchema.static;
