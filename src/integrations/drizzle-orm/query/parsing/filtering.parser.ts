import { and, eq, gte, inArray, lte, type SQL, sql } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { serverConstants } from "@/config/server/server.constants";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { trimAndFilter } from "@/utils/array.utils";
import { DomainError } from "@/utils/domain.errors";
import { isNotNullish } from "@/utils/type.utils";

export function filterEquals(column: SQLiteColumn, value: string | number | boolean): SQL {
	return eq(column, value);
}

export function filterInArray(column: SQLiteColumn, values: string[] | undefined): SQL | undefined {
	if (!values) return undefined;

	return inArray(column, values);
}

export function filterGte(column: SQLiteColumn, value: string | number | boolean): SQL {
	return gte(column, value);
}

export function filterLte(column: SQLiteColumn, value: string | number | boolean): SQL {
	return lte(column, value);
}

export function filterLike(column: SQLiteColumn, searchTerm: string): SQL {
	// Wildcards are matched literally: a user searching "50%" means the
	// literal text, not "50" followed by anything.
	const escaped = searchTerm.replace(/[\\%_]/g, (char) => `\\${char}`);

	return sql`${column} LIKE ${`%${escaped}%`} ESCAPE ${"\\"}`;
}

/** A prefix match — the same literal-wildcard rule as {@link filterLike}. */
export function filterStartsWith(column: SQLiteColumn, prefix: string): SQL {
	const escaped = prefix.replace(/[\\%_]/g, (char) => `\\${char}`);

	return sql`${column} LIKE ${`${escaped}%`} ESCAPE ${"\\"}`;
}

export function filterM2M(
	column: SQLiteColumn,
	values: string | string[] | undefined,
	junctionTable: SQLiteTable,
	junctionColumn: SQLiteColumn,
	junctionField: SQLiteColumn,
): SQL | undefined {
	if (!values) return undefined;

	const ids = Array.isArray(values) ? values : parseCommaSeparated(values);
	if (!ids || ids.length === 0) return undefined;

	if (ids.length > serverConstants.database.filters.maxValues) {
		throw new DomainError("validation", `Filter must not contain more than ${serverConstants.database.filters.maxValues} values`, {
			code: "validation.filter_too_many_values",
			params: { max: serverConstants.database.filters.maxValues },
		});
	}

	return inArray(
		column,
		databaseFactory.getClient().select({ col: junctionColumn }).from(junctionTable).where(inArray(junctionField, ids)),
	);
}

export function combineFilters(conditions: Array<SQL | undefined>): SQL | undefined {
	const validConditions = conditions.filter((condition) => isNotNullish(condition));

	return validConditions.length > 0 ? and(...validConditions) : undefined;
}

export function parseCommaSeparated(value: string | undefined): string[] | undefined {
	if (!value) return undefined;

	const values = trimAndFilter(value.split(","));
	if (values.length > serverConstants.database.filters.maxValues) {
		throw new DomainError("validation", `Filter must not contain more than ${serverConstants.database.filters.maxValues} values`, {
			code: "validation.filter_too_many_values",
			params: { max: serverConstants.database.filters.maxValues },
		});
	}

	return values;
}
