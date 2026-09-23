import { type BuildColumns, sql } from "drizzle-orm";
import {
	type AnySQLiteColumn,
	check,
	integer,
	primaryKey,
	real,
	type SQLiteTableWithColumns,
	type SQLiteTextBuilder,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { providers } from "../schemas/providers.schema";
import { DatabaseHelper } from "./database-helper";

type JunctionEntityColumn = ReturnType<typeof DatabaseHelper.tableRef>;

/** Typed view of a junction table: the entity column keeps its literal key so relations stay precise. */
type JunctionTable<TColumns extends Record<string, JunctionEntityColumn>> = SQLiteTableWithColumns<{
	name: string;
	schema: undefined;
	columns: BuildColumns<string, TColumns & { providerId: JunctionEntityColumn }, "sqlite">;
	dialect: "sqlite";
}>;

function providerJunctionColumns(entityIdColumn: string, entityIdRef: () => AnySQLiteColumn) {
	return {
		[entityIdColumn]: DatabaseHelper.tableRef(entityIdColumn, entityIdRef, { onDelete: "cascade" }),
		providerId: DatabaseHelper.tableRef("provider_id", () => providers.id, { onDelete: "cascade" }),
	};
}

export function createProviderJunction<TEntityIdColumn extends string>(
	tableName: string,
	entityIdColumn: TEntityIdColumn,
	entityIdRef: () => AnySQLiteColumn,
): JunctionTable<Record<TEntityIdColumn, JunctionEntityColumn>>;

export function createProviderJunction(tableName: string, entityIdColumn: string, entityIdRef: () => AnySQLiteColumn) {
	const columns = providerJunctionColumns(entityIdColumn, entityIdRef);

	return sqliteTable(tableName, columns, (t) => {
		const entityColumn = t[entityIdColumn];
		if (!entityColumn) throw new Error(`${tableName}: entity column "${entityIdColumn}" is missing from the junction table`);

		return [primaryKey({ columns: [entityColumn, t.providerId] }), uniqueIndex(`${tableName}_provider_unique`).on(t.providerId)];
	});
}

type RatingsEntityBuilder =
	| JunctionEntityColumn
	| SQLiteTextBuilder<[string, ...string[]]>
	| ReturnType<typeof ratingsValueColumn>
	| ReturnType<typeof ratingsVotesColumn>;

type RatingsJunctionColumns<TKey extends string> = Record<TKey, RatingsEntityBuilder> & {
	source: ReturnType<typeof ratingsSourceColumn>;
	label: ReturnType<typeof ratingsLabelColumn>;
	value: ReturnType<typeof ratingsValueColumn>;
	votes: ReturnType<typeof ratingsVotesColumn>;
	maxValue: ReturnType<typeof ratingsMaxValueColumn>;
	url: ReturnType<typeof ratingsUrlColumn>;
};

type RatingsJunctionTable<TKey extends string> = SQLiteTableWithColumns<{
	name: string;
	schema: undefined;
	columns: BuildColumns<string, RatingsJunctionColumns<TKey>, "sqlite">;
	dialect: "sqlite";
}>;

function ratingsSourceColumn() {
	return text("source").notNull();
}

function ratingsLabelColumn() {
	return text("label");
}

function ratingsUrlColumn() {
	return text("url");
}

function ratingsValueColumn() {
	return real("value").notNull();
}

function ratingsVotesColumn() {
	return integer("votes").notNull().default(0);
}

function ratingsMaxValueColumn() {
	return integer("max_value").notNull().default(10);
}

export function createRatingsJunction<TEntityIdColumn extends string>(
	tableName: string,
	entityIdColumn: TEntityIdColumn,
	entityIdColumnName: string,
	entityIdRef: () => AnySQLiteColumn,
): RatingsJunctionTable<TEntityIdColumn> {
	const entityEntries: Record<string, RatingsEntityBuilder> = {
		[entityIdColumn]: DatabaseHelper.tableRef(entityIdColumnName, entityIdRef, { onDelete: "cascade" }),
	};
	const columns: RatingsJunctionColumns<TEntityIdColumn> = Object.assign(entityEntries, {
		source: ratingsSourceColumn(),
		label: ratingsLabelColumn(),
		value: ratingsValueColumn(),
		votes: ratingsVotesColumn(),
		maxValue: ratingsMaxValueColumn(),
		url: ratingsUrlColumn(),
	});

	return sqliteTable(tableName, columns, (t) => {
		return [
			primaryKey({ columns: [t[entityIdColumn], t.source] }),
			check(
				`${tableName}_values_check`,
				sql`${t.maxValue} IS NOT NULL AND ${t.maxValue} > 0
					AND ${t.value} >= 0 AND ${t.value} <= ${t.maxValue}
					AND (${t.votes} IS NULL OR ${t.votes} >= 0)`,
			),
		];
	});
}
