import type { SortOrder } from "@sdk/common/sorting";
import { asc, desc, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";

/**
 * Sorting helpers for the API
 */
export const QuerySorting = {
	/**
	 * Builds the SQL order-by expression
	 */
	apply(column: SQLiteColumn | SQL | undefined, order: SortOrder): SQL {
		if (!column) throw new Error("Column is undefined");

		return order === "desc" ? desc(column) : asc(column);
	},
};
