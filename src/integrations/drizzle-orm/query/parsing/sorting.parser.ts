import type { SortOrder } from "@reelvault/sdk/common";
import { asc, desc, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { DomainError } from "@/utils/domain.errors";

/**
 * Sorting helpers for the API
 */
export const QuerySorting = {
	/**
	 * Builds the SQL order-by expression
	 */
	apply(column: SQLiteColumn | SQL | undefined, order: SortOrder): SQL {
		if (!column) throw new DomainError("internal", "Column is undefined", { code: "query.sort_column_missing" });

		return order === "desc" ? desc(column) : asc(column);
	},
};
