import { SortQuerySchema } from "@sdk/common/sorting";
import { t } from "elysia";
import { EntitySchema } from "./schema-utils";

export const KeywordSchema = EntitySchema(t.Object({ id: t.String(), stableKey: t.String(), name: t.String() }));

export type Keyword = typeof KeywordSchema.static;

export const CreateKeywordSchema = t.Object({
	name: t.String({ minLength: 1 }),
});

export type CreateKeyword = typeof CreateKeywordSchema.static;

export const UpdateKeywordSchema = t.Partial(CreateKeywordSchema);

export type UpdateKeyword = typeof UpdateKeywordSchema.static;

export const KeywordFiltersSchema = t.Object({
	name: t.Optional(t.String()),
});

export type KeywordFilters = typeof KeywordFiltersSchema.static;

export const KeywordSortingSchema = t.Composite([
	SortQuerySchema,
	t.Object({
		sortBy: t.Optional(t.Union([t.Literal("name"), t.Literal("createdAt"), t.Literal("updatedAt")])),
	}),
]);

export type KeywordSorting = typeof KeywordSortingSchema.static;
