import { and, eq, gte, inArray, lte, type SQL, sql } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { databaseFactory } from "@/database/database";
import { serverConfig } from "@/server.config";
import { isNotNullish, trimAndFilter } from "@/utils/array.utils";
import { ValidationError } from "@/utils/errors";

export const QueryFiltering = {
	eq(column: SQLiteColumn, value: string | number | boolean): SQL {
		return eq(column, value);
	},

	inArray(column: SQLiteColumn, values: string[] | undefined): SQL | undefined {
		if (!values) return undefined;

		return inArray(column, values);
	},

	gte(column: SQLiteColumn, value: string | number | boolean): SQL {
		return gte(column, value);
	},

	lte(column: SQLiteColumn, value: string | number | boolean): SQL {
		return lte(column, value);
	},

	like(column: SQLiteColumn, searchTerm: string): SQL {
		// Wildcards are matched literally: a user searching "50%" means the
		// literal text, not "50" followed by anything.
		const escaped = searchTerm.replace(/[\\%_]/g, (char) => `\\${char}`);

		return sql`${column} LIKE ${`%${escaped}%`} ESCAPE ${"\\"}`;
	},

	m2m(
		column: SQLiteColumn,
		values: string | string[] | undefined,
		junctionTable: SQLiteTable,
		junctionColumn: SQLiteColumn,
		junctionField: SQLiteColumn,
	): SQL | undefined {
		if (!values) return undefined;

		const ids = Array.isArray(values) ? values : QueryFiltering.parseCommaSeparated(values);
		if (!ids || ids.length === 0) return undefined;

		if (ids.length > serverConfig.database.filters.maxValues) {
			throw new ValidationError(`Filter must not contain more than ${serverConfig.database.filters.maxValues} values`);
		}

		return inArray(
			column,
			databaseFactory.getClient().select({ col: junctionColumn }).from(junctionTable).where(inArray(junctionField, ids)),
		);
	},

	combine(conditions: Array<SQL | undefined>): SQL | undefined {
		const validConditions = conditions.filter((condition) => isNotNullish(condition));

		return validConditions.length > 0 ? and(...validConditions) : undefined;
	},

	parseCommaSeparated(value: string | undefined): string[] | undefined {
		if (!value) return undefined;

		const values = trimAndFilter(value.split(","));
		if (values.length > serverConfig.database.filters.maxValues) {
			throw new ValidationError(`Filter must not contain more than ${serverConfig.database.filters.maxValues} values`);
		}

		return values;
	},
};
