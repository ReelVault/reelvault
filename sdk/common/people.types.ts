import { SortQuerySchema } from "@sdk/common/sorting";
import { t } from "elysia";
import { ImageSchema } from "./image.types";
import { EntitySchema } from "./schema-utils";

export const PersonSchema = EntitySchema(
	t.Object({
		id: t.String(),
		stableKey: t.String(),
		imageId: t.Nullable(t.String()),
		name: t.String(),
		biography: t.Nullable(t.String()),
		gender: t.Nullable(t.Union([t.Literal("male"), t.Literal("female"), t.Literal("other")])),
		birthday: t.Nullable(t.String()),
		knownCredits: t.Nullable(t.Integer({ minimum: 0 })),
		popularity: t.Number({ minimum: 0 }),
	}),
);

export type Person = typeof PersonSchema.static;

export const PersonGenderSchema = PersonSchema.properties.gender;

export const PersonWithRelationsSchema = t.Composite([
	PersonSchema,
	t.Object({
		image: t.Nullable(ImageSchema),
	}),
]);

export type PersonWithRelations = typeof PersonWithRelationsSchema.static;

export const CreatePersonSchema = t.Object({
	name: t.String({ minLength: 1 }),
	originalName: t.Optional(t.String()),
	biography: t.Optional(t.String()),
	birthday: t.Optional(t.String()),
	deathday: t.Optional(t.String()),
	gender: t.Optional(PersonGenderSchema),
	placeOfBirth: t.Optional(t.String()),
	popularity: t.Optional(t.Numeric({ minimum: 0 })),
	knownForDepartment: t.Optional(t.String()),
});

export type CreatePerson = typeof CreatePersonSchema.static;

export const UpdatePersonSchema = t.Partial(CreatePersonSchema);

export type UpdatePerson = typeof UpdatePersonSchema.static;

export const PersonFiltersSchema = t.Object({
	name: t.Optional(t.String()),
});

export type PersonFilters = typeof PersonFiltersSchema.static;

export const PersonSortingSchema = t.Composite([
	SortQuerySchema,
	t.Object({
		sortBy: t.Optional(t.Union([t.Literal("name"), t.Literal("createdAt"), t.Literal("updatedAt")])),
	}),
]);

export type PersonSorting = typeof PersonSortingSchema.static;
