import type { SortOrder } from "@reelvault/sdk/common";
import { asc, desc, type SQL, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { DomainError } from "@/utils/domain.errors";

/** Builds the SQL order-by expression. */
export function applySorting(column: SQLiteColumn | SQL | undefined, order: SortOrder): SQL {
	if (!column) throw new DomainError("internal", "Column is undefined", { code: "query.sort_column_missing" });

	return order === "desc" ? desc(column) : asc(column);
}

/**
 * Appends a unique tiebreaker to an ORDER BY clause, in the sort's own direction.
 *
 * The tiebreaker keeps offset pagination deterministic for non-unique sort
 * keys (title and createdAt at second resolution). It has to follow the sort
 * direction: a DESC sort with an ASC tiebreaker is a mixed-direction ORDER
 * BY, which SQLite cannot serve from a single index — it adds a temp B-tree
 * for the last term and sorts the whole filtered set at deep offsets.
 */
export function withTiebreaker(orderBy: SQL, column: SQLiteColumn | SQL, order: SortOrder): SQL {
	return sql`${orderBy}, ${order === "desc" ? desc(column) : asc(column)}`;
}
