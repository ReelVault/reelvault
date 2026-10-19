import { type SQL, type SQLChunk, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { safeParseJson } from "@/utils/file.utils";

/**
 * Builders and readers for relation payloads carried as JSON columns: one
 * statement returns a row plus its relations as JSON arrays, replacing a
 * per-relation round trip. Used by the metadata detail/list readers and the
 * single-row media-file bundle. JSON is preferable to `UNION ALL` because the
 * relations have different column sets; the cost is reviving the values that
 * drizzle would normally map (booleans, timestamps).
 */

/** One relation as a JSON array — `[]` when the subquery matches nothing. */
export function relationJsonArray(rows: SQL): SQL<string> {
	return sql<string>`coalesce((${rows}), '[]')`;
}

/** Inner SELECT aliases every column to its DTO key so the outer json_object can read it. */
export function aliasedColumns(columns: Record<string, SQLiteColumn>, prefix: string): { selectList: SQL; pairs: SQLChunk[] } {
	const selectParts: SQL[] = [];
	const pairs: SQLChunk[] = [];
	for (const [key, column] of Object.entries(columns)) {
		const alias = `${prefix}${key}`;
		selectParts.push(sql`${column} AS ${sql.identifier(alias)}`);
		pairs.push(sql`${key}`, sql.identifier(alias));
	}

	return { selectList: sql.join(selectParts, sql`, `), pairs };
}

/** `json_group_array` over an aliased subquery — one relation (or scope row list) as one column. */
export function relationJsonArrayOver(columns: Record<string, SQLiteColumn>, from: SQLChunk): SQL<string> {
	const aliased = aliasedColumns(columns, "");

	return relationJsonArray(
		sql`SELECT json_group_array(json_object(${sql.join(aliased.pairs, sql`, `)})) FROM (SELECT ${aliased.selectList} FROM ${from})`,
	);
}

/** `json_group_array` over an ordered, aliased subquery — row order matches the inner ORDER BY. */
export function orderedJsonArray(selectList: SQLChunk, pairs: SQLChunk[], from: SQLChunk, orderBy: SQLChunk): SQL<string> {
	return relationJsonArray(
		sql`SELECT json_group_array(json_object(${sql.join(pairs, sql`, `)})) FROM (SELECT ${selectList} FROM ${from} ORDER BY ${orderBy})`,
	);
}

/** A single entity as a JSON object; NULL when the subquery matches no row. */
export function jsonObjectRow(selectList: SQLChunk, pairs: SQLChunk[], from: SQLChunk): SQL<string | null> {
	return sql<string | null>`(SELECT json_object(${sql.join(pairs, sql`, `)}) FROM (SELECT ${selectList} FROM ${from}))`;
}

/** Keys of `timestamp` columns, which drizzle maps to Date but JSON returns as raw seconds. */
export function dateKeysOf(columns: Record<string, SQLiteColumn>): string[] {
	return Object.entries(columns)
		.filter(([, column]) => column.dataType === "object date")
		.map(([key]) => key);
}

/** Keys of integer `mode: "boolean"` columns, which JSON returns as 0/1. */
export function booleanKeysOf(columns: Record<string, SQLiteColumn>): string[] {
	return Object.entries(columns)
		.filter(([, column]) => column.dataType === "boolean")
		.map(([key]) => key);
}

export interface RelationJsonKeys {
	booleanKeys: readonly string[];
	dateKeys: readonly string[];
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Applies the mappings SQLite JSON cannot carry: 0/1 → boolean, seconds → Date. */
export function reviveJsonItem(item: unknown, keys: RelationJsonKeys): void {
	if (!isRecordValue(item)) return;

	for (const key of keys.booleanKeys) {
		const value = item[key];
		if (value === 0) item[key] = false;
		else if (value === 1) item[key] = true;
	}

	for (const key of keys.dateKeys) {
		const value = item[key];
		if (typeof value === "number") item[key] = new Date(value * 1000);
	}
}

/**
 * Narrows a JSON payload item to the DTO shape. The SQL builder emits exactly
 * the columns in `keys`; `_shape` anchors the type parameter to the caller's
 * DTO type.
 */
function isRelationItem<T extends object>(item: unknown, keys: readonly string[], _shape?: T): item is T {
	if (!isRecordValue(item)) return false;

	return keys.every((key) => key in item);
}

/** Parses a `json_group_array` payload into DTO items, dropping malformed entries. */
export function parseJsonRelationArray<T extends object>(
	payload: string,
	keys: readonly string[],
	revive: RelationJsonKeys,
	_shape?: T,
): T[] {
	const parsed = safeParseJson(payload);
	if (!Array.isArray(parsed)) return [];

	const items: T[] = [];
	for (const item of parsed) {
		if (!isRelationItem<T>(item, keys)) continue;

		reviveJsonItem(item, revive);
		items.push(item);
	}

	return items;
}

/** Parses a single `json_object` payload; `undefined` when the JSON is null or malformed. */
export function parseJsonRelationObject<T extends object>(
	payload: string | null,
	keys: readonly string[],
	revive: RelationJsonKeys,
	_shape?: T,
): T | undefined {
	if (payload === null) return undefined;

	const parsed = safeParseJson(payload);
	if (!isRelationItem<T>(parsed, keys)) return undefined;

	reviveJsonItem(parsed, revive);

	return parsed;
}
