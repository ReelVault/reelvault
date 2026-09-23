import { t } from "elysia";

export const SortQuerySchema = t.Object({
	sortBy: t.Optional(t.String()),
	sortOrder: t.Optional(t.Union([t.Literal("asc"), t.Literal("desc")])),
});

export type SortQuery = typeof SortQuerySchema.static;

export type SortOrder = NonNullable<SortQuery["sortOrder"]>;
