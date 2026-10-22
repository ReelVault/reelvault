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
import { idColumn, tableRef, timestampColumns } from "@/integrations/drizzle-orm/query/database-helper.utils";
import { providers } from "@/integrations/drizzle-orm/schemas/providers.schema";
import { DomainError } from "@/utils/domain.errors";

type JunctionEntityColumn = ReturnType<typeof tableRef>;

/** Typed view of a junction table: the entity column keeps its literal key so relations stay precise. */
type JunctionTable<TColumns extends Record<string, JunctionEntityColumn>> = SQLiteTableWithColumns<{
	name: string;
	schema: undefined;
	columns: BuildColumns<string, TColumns & { providerId: JunctionEntityColumn }, "sqlite">;
	dialect: "sqlite";
}>;

function providerJunctionColumns(entityIdColumn: string, entityIdRef: () => AnySQLiteColumn) {
	return {
		[entityIdColumn]: tableRef(entityIdColumn, entityIdRef, { onDelete: "cascade" }),
		providerId: tableRef("provider_id", () => providers.id, { onDelete: "cascade" }),
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
		if (!entityColumn)
			throw new DomainError("internal", `${tableName}: entity column "${entityIdColumn}" is missing from the junction table`, {
				code: "junction.entity_column_missing",
			});

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
		[entityIdColumn]: tableRef(entityIdColumnName, entityIdRef, { onDelete: "cascade" }),
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
	id: typeof idColumn;
	profileId: ReturnType<typeof tableRef>;
	metadataId: ReturnType<typeof tableRef>;
} & typeof timestampColumns;

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
			id: idColumn,
			profileId: tableRef("profile_id", refs.profileId, { onDelete: "cascade" }),
			metadataId: tableRef("metadata_id", refs.metadataId, { onDelete: "cascade" }),
			...extraColumns,
			...timestampColumns,
		},
		(t) => [
			uniqueIndex(`${tableName}_unique`).on(t.profileId, t.metadataId),
			index(`${tableName}_metadata_idx`).on(t.metadataId),
			// The list pages filter by profile and sort by created_at with the id as
			// a tiebreaker, so the index has to carry all three in that order.
			index(`${tableName}_profile_created_id_idx`).on(t.profileId, t.createdAt, t.id),
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
		metadataId: tableRef("metadata_id", metadataIdRef, { onDelete: "cascade" }),
		[entityIdColumn]: tableRef(entityIdColumnName, entityIdRef, { onDelete: "cascade" }),
	};

	return sqliteTable(tableName, columns, (t) => {
		const entityColumn = t[entityIdColumn];
		if (!entityColumn)
			throw new DomainError("internal", `${tableName}: entity column "${entityIdColumn}" is missing from the junction table`, {
				code: "junction.entity_column_missing",
			});

		const entityName = entityIdColumnName.endsWith("_id") ? entityIdColumnName.slice(0, -3) : entityIdColumnName;

		// Carry metadata_id so relation lookups by entity (recommendations, filtered
		// browse) are covering reads instead of one table lookup per match.
		return [
			primaryKey({ columns: [t.metadataId, entityColumn] }),
			index(`${tableName}_${entityName}_metadata_idx`).on(entityColumn, t.metadataId),
		];
	});
}
