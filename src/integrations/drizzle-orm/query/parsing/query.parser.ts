import type { FieldsConfig, FieldsQuery, PaginationQuery, SortOrder, SortQuery } from "@reelvault/sdk/common";
import type { SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { parsePagination } from "@/integrations/drizzle-orm/query/pagination.utils";
import { parseFields } from "./fields.parser";
import { combineFilters } from "./filtering.parser";
import { applySorting } from "./sorting.parser";

export type QueryFilterMap<T extends object> = {
	[K in keyof T]: (value: NonNullable<T[K]>) => SQL | undefined;
};

export interface QueryMap<T extends object, C extends SortQuery> {
	filters: QueryFilterMap<T>;
	orderBy: Record<NonNullable<C["sortBy"]>, SQLiteColumn | SQL>;
	// Optional: default sorting stored in the map
	defaults?: {
		sortBy: NonNullable<C["sortBy"]>;
		sortOrder: "asc" | "desc";
	};
}

function isKeyOf<T extends object>(key: string | undefined, obj: T): key is keyof T & string {
	return key !== undefined && key in obj;
}

export function buildWhereConditions<T extends object>(filters: T | undefined, map: QueryFilterMap<T>): SQL | undefined {
	if (!filters) return undefined;

	const conditions: Array<SQL | undefined> = [];

	for (const key of Object.keys(filters)) {
		if (!(isKeyOf(key, filters) && isKeyOf(key, map))) continue;

		const value = filters[key];
		if (value === undefined || value === null || value === "") continue;

		conditions.push(map[key](value));
	}

	return combineFilters(conditions);
}

/**
 * The sort direction a request resolves to: the explicit sortOrder wins,
 * then the default's, then ascending.
 */
export function resolveSortOrder(sorting: SortQuery | undefined, defaultSorting?: { sortOrder: SortOrder }): SortOrder {
	return sorting?.sortOrder ?? defaultSorting?.sortOrder ?? "asc";
}

/**
 * Builds the ORDER BY clause.
 * Params passed in 'sorting' take priority; falls back to 'defaultSorting'.
 */
export function buildOrderBy<T extends SortQuery, C extends SortQuery>(
	sorting: T | undefined,
	map: QueryMap<T, C>["orderBy"],
	defaultSorting?: { sortBy: keyof typeof map; sortOrder: SortOrder },
): SQL | undefined {
	if (!(sorting || defaultSorting)) return undefined;

	const sortBy = sorting?.sortBy && isKeyOf(sorting.sortBy, map) ? sorting.sortBy : defaultSorting?.sortBy;
	const sortOrder = resolveSortOrder(sorting, defaultSorting);
	if (!isKeyOf(sortBy, map)) return undefined;

	return applySorting(map[sortBy], sortOrder);
}

export function parseStandardQuery<F extends string>(
	query?: PaginationQuery & FieldsQuery<F> & SortQuery,
): { pagination: ReturnType<typeof parsePagination>; fields: FieldsConfig<F> } {
	return {
		pagination: parsePagination({ ...query }),
		fields: parseFields({ fields: query?.fields }),
	};
}

export function parseWithFilters<F extends string, T extends object, S extends SortQuery>(
	query?: PaginationQuery & FieldsQuery<F> & SortQuery & T & S,
): {
	pagination: ReturnType<typeof parsePagination>;
	fields: FieldsConfig<F>;
	filters: T | undefined;
	sorting: S | undefined;
} {
	const base = parseStandardQuery(query);

	return {
		...base,
		filters: query,
		sorting: query,
	};
}
