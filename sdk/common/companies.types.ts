import { SortQuerySchema } from "@sdk/common/sorting";
import { t } from "elysia";
import { EntitySchema } from "./schema-utils";

export const CompanySchema = EntitySchema(
	t.Object({
		id: t.String(),
		stableKey: t.String(),
		imageId: t.Nullable(t.String()),
		name: t.String(),
		originalName: t.Nullable(t.String()),
	}),
);

export type Company = typeof CompanySchema.static;

export const CreateCompanySchema = t.Object({
	name: t.String({ minLength: 1 }),
});

export type CreateCompany = typeof CreateCompanySchema.static;

export const UpdateCompanySchema = t.Partial(CreateCompanySchema);

export type UpdateCompany = typeof UpdateCompanySchema.static;

export const CompanyFiltersSchema = t.Object({
	name: t.Optional(t.String()),
});

export type CompanyFilters = typeof CompanyFiltersSchema.static;

export const CompanySortingSchema = t.Composite([
	SortQuerySchema,
	t.Object({
		sortBy: t.Optional(t.Union([t.Literal("name"), t.Literal("createdAt"), t.Literal("updatedAt")])),
	}),
]);

export type CompanySorting = typeof CompanySortingSchema.static;
