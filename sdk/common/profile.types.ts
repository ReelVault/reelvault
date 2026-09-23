import { SortQuerySchema } from "@sdk/common/sorting";
import { t } from "elysia";
import { EntitySchema } from "./schema-utils";

export const ProfileSchema = EntitySchema(
	t.Object({ id: t.String(), userId: t.String(), name: t.String(), avatarUrl: t.Nullable(t.String()), pin: t.Nullable(t.String()) }),
);

export type Profile = typeof ProfileSchema.static;

export const CreateProfileSchema = t.Object({
	name: t.String({ minLength: 1 }),
	pin: t.Optional(t.Union([t.String({ minLength: 4, maxLength: 8 }), t.Undefined()])),
	avatarUrl: t.Optional(t.Union([t.String(), t.Undefined()])),
});

export type CreateProfile = typeof CreateProfileSchema.static;

export const UpdateProfileSchema = t.Partial(CreateProfileSchema);

export type UpdateProfile = typeof UpdateProfileSchema.static;

export const SwitchProfileSchema = t.Object({
	profileId: t.String(),
	pin: t.Optional(t.String({ minLength: 4, maxLength: 8 })),
});

export type SwitchProfile = typeof SwitchProfileSchema.static;

export const ProfileFiltersSchema = t.Object({
	userId: t.Optional(t.String()),
	name: t.Optional(t.String()),
});

export type ProfileFilters = typeof ProfileFiltersSchema.static;

export const ProfileSortingSchema = t.Composite([
	SortQuerySchema,
	t.Object({
		sortBy: t.Optional(t.Union([t.Literal("name"), t.Literal("createdAt"), t.Literal("updatedAt")])),
	}),
]);

export type ProfileSorting = typeof ProfileSortingSchema.static;
