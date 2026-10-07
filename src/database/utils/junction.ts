import { type BuildColumns, type ColumnBuilderBase, sql } from "drizzle-orm";
import {
	type AnySQLiteColumn,
	check,
	index,
	integer,
	primaryKey,
	real,
	type SQLiteTableExtraConfigValue,
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

		// Composite PK only. A provider row is shared per (name, external id,
		// entity type) and may legitimately link to several local rows (duplicates,
		// localized renames) — a unique index on `provider_id` silently dropped
		// every link after the first. The non-unique index still lets lookups and
		// FK cascades driven by `provider_id` use a seek instead of a table scan.
		return [primaryKey({ columns: [entityColumn, t.providerId] }), index(`${tableName}_provider_idx`).on(t.providerId)];
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

type ProfileMetadataLinkColumns = {
	id: typeof DatabaseHelper.id;
	profileId: ReturnType<typeof DatabaseHelper.tableRef>;
	metadataId: ReturnType<typeof DatabaseHelper.tableRef>;
} & typeof DatabaseHelper.timestamps;

/**
 * Profile↔metadata link table (id, cascade FKs to both entities, timestamps)
 * with the shared unique/metadata/profile-created indexes. `extraColumns` land
 * between the FKs and the timestamps; `extraConfig` is appended after the
 * shared indexes.
 */
export function createProfileMetadataLink<TExtraColumns extends Record<string, ColumnBuilderBase>>(
	tableName: string,
	refs: { profileId: () => AnySQLiteColumn; metadataId: () => AnySQLiteColumn },
	extraColumns: TExtraColumns,
	extraConfig?: (t: BuildColumns<string, ProfileMetadataLinkColumns & TExtraColumns, "sqlite">) => SQLiteTableExtraConfigValue[],
) {
	return sqliteTable(
		tableName,
		{
			id: DatabaseHelper.id,
			profileId: DatabaseHelper.tableRef("profile_id", refs.profileId, { onDelete: "cascade" }),
			metadataId: DatabaseHelper.tableRef("metadata_id", refs.metadataId, { onDelete: "cascade" }),
			...extraColumns,
			...DatabaseHelper.timestamps,
		},
		(t) => [
			uniqueIndex(`${tableName}_unique`).on(t.profileId, t.metadataId),
			index(`${tableName}_metadata_idx`).on(t.metadataId),
			index(`${tableName}_profile_created_idx`).on(t.profileId, t.createdAt),
			...(extraConfig?.(t) ?? []),
		],
	);
}

/** Typed view of a metadata↔entity junction: the entity column keeps its literal key. */
type EntityJunctionTable<TEntityIdColumn extends string> = SQLiteTableWithColumns<{
	name: string;
	schema: undefined;
	columns: BuildColumns<string, Record<TEntityIdColumn, JunctionEntityColumn> & { metadataId: JunctionEntityColumn }, "sqlite">;
	dialect: "sqlite";
}>;

/**
 * Metadata↔entity junction: composite primary key plus an index on the entity
 * side named `${tableName}_${entity}_idx` (entity column name minus `_id`).
 */
export function createMetadataEntityJunction<TEntityIdColumn extends string>(
	tableName: string,
	entityIdColumn: TEntityIdColumn,
	entityIdColumnName: string,
	entityIdRef: () => AnySQLiteColumn,
	metadataIdRef: () => AnySQLiteColumn,
): EntityJunctionTable<TEntityIdColumn>;

export function createMetadataEntityJunction(
	tableName: string,
	entityIdColumn: string,
	entityIdColumnName: string,
	entityIdRef: () => AnySQLiteColumn,
	metadataIdRef: () => AnySQLiteColumn,
) {
	const columns = {
		metadataId: DatabaseHelper.tableRef("metadata_id", metadataIdRef, { onDelete: "cascade" }),
		[entityIdColumn]: DatabaseHelper.tableRef(entityIdColumnName, entityIdRef, { onDelete: "cascade" }),
	};

	return sqliteTable(tableName, columns, (t) => {
		const entityColumn = t[entityIdColumn];
		if (!entityColumn) throw new Error(`${tableName}: entity column "${entityIdColumn}" is missing from the junction table`);

		const entityName = entityIdColumnName.endsWith("_id") ? entityIdColumnName.slice(0, -3) : entityIdColumnName;

		return [primaryKey({ columns: [t.metadataId, entityColumn] }), index(`${tableName}_${entityName}_idx`).on(entityColumn)];
	});
}
