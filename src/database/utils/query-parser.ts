import type { FieldsConfig, FieldsQuery, PaginationQuery, SortOrder, SortQuery } from "@reelvault/sdk/common";
import type { SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { QueryFields } from "./fields";
import { QueryFiltering } from "./filtering";
import { QueryPagination } from "./pagination";
import { QuerySorting } from "./sorting";

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

export const QueryUtils = {
	buildWhereConditions<T extends object>(filters: T | undefined, map: QueryFilterMap<T>): SQL | undefined {
		if (!filters) return undefined;

		const conditions: Array<SQL | undefined> = [];

		for (const key of Object.keys(filters)) {
			if (!(isKeyOf(key, filters) && isKeyOf(key, map))) continue;

			const value = filters[key];
			if (value === undefined || value === null || value === "") continue;

			conditions.push(map[key](value));
		}

		return QueryFiltering.combine(conditions);
	},

	/**
	 * Builds the ORDER BY clause.
	 * Params passed in 'sorting' take priority; falls back to 'defaultSorting'.
	 */
	buildOrderBy<T extends SortQuery, C extends SortQuery>(
		sorting: T | undefined,
		map: QueryMap<T, C>["orderBy"],
		defaultSorting?: { sortBy: keyof typeof map; sortOrder: SortOrder },
	): SQL | undefined {
		if (!(sorting || defaultSorting)) return undefined;

		const sortBy = sorting?.sortBy && isKeyOf(sorting.sortBy, map) ? sorting.sortBy : defaultSorting?.sortBy;
		const sortOrder = sorting?.sortOrder ?? defaultSorting?.sortOrder ?? "asc";
		if (!isKeyOf(sortBy, map)) return undefined;

		const column = map[sortBy];

		return QuerySorting.apply(column, sortOrder);
	},

	parseStandard<F extends string>(
		query?: PaginationQuery & FieldsQuery<F> & SortQuery,
	): { pagination: ReturnType<typeof QueryPagination.parse>; fields: FieldsConfig<F> } {
		return {
			pagination: QueryPagination.parse({ ...query }),
			fields: QueryFields.parse({ fields: query?.fields }),
		};
	},

	parseWithFilters<F extends string, T extends object, S extends SortQuery>(
		query?: PaginationQuery & FieldsQuery<F> & SortQuery & T & S,
	): {
		pagination: ReturnType<typeof QueryPagination.parse>;
		fields: FieldsConfig<F>;
		filters: T | undefined;
		sorting: S | undefined;
	} {
		const base = QueryUtils.parseStandard(query);

		return {
			...base,
			filters: query,
			sorting: query,
		};
	},
};
