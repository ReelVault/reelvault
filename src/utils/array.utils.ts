import { isNonEmptyString } from "./type.utils";

/**
 * Type guard that filters out `null` and `undefined` values from an array.
 */
export function isNotNullish<T>(value: T | null | undefined): value is T {
	return value != null;
}

export function hasEntry(entries: object | Record<string, unknown> | undefined | null): boolean {
	if (entries === undefined || entries === null) return false;

	for (const _ in entries) {
		return true;
	}

	return false;
}

/**
 * Splits an array into chunks of a given size.
 */
export function chunk<T>(array: readonly T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let i = 0; i < array.length; i += size) {
		chunks.push(array.slice(i, i + size));
	}

	return chunks;
}

/** Item with the highest `scoreOf(item)`; ties keep the first seen. */
export function maxBy<T>(items: readonly T[], scoreOf: (item: T) => number): T | undefined {
	let best: T | undefined;
	let bestScore = Number.NEGATIVE_INFINITY;
	for (const item of items) {
		const score = scoreOf(item);
		if (!best || score > bestScore) {
			best = item;
			bestScore = score;
		}
	}

	return best;
}

/**
 * Deduplicates an array, optionally extracting a key first.
 * Replaces both `[...new Set(array)]` and `[...new Set(array.map(x => x.field))]`.
 */
export function unique<T>(items: readonly T[]): T[];

export function unique<T, K>(items: readonly T[], keySelector: (item: T) => K): K[];

export function unique<T, K>(items: readonly T[], keySelector?: (item: T) => K): Array<T | K> {
	if (keySelector) {
		const set = new Set<K>();
		for (const item of items) set.add(keySelector(item));

		return [...set];
	}

	return [...new Set(items)];
}

/**
 * Builds a Map from an array by key selector (and optional value selector).
 * Replaces the common `new Map(array.map(x => [x.id, x]))` pattern.
 */
export function toMap<T, K>(items: readonly T[], keySelector: (item: T) => K): Map<K, T>;

export function toMap<T, K, V>(items: readonly T[], keySelector: (item: T) => K, valueSelector: (item: T) => V): Map<K, V>;

export function toMap<T, K, V = T>(items: readonly T[], keySelector: (item: T) => K, valueSelector?: (item: T) => V): Map<K, V | T> {
	const map = new Map<K, V | T>();
	for (const item of items) map.set(keySelector(item), valueSelector ? valueSelector(item) : item);

	return map;
}

/**
 * Extracts defined (`string`) `id` fields from an array of objects.
 * Skips items where `id` is null, undefined, or empty after trimming.
 * Replaces the common `?.map(x => x.id).filter(id => Boolean(id)) || []` pattern.
 */
export function pluckValidIds(items: Array<{ id?: string | null | undefined }> | undefined): string[] {
	if (!items) return [];

	const result: string[] = [];
	for (const item of items) {
		const id = item.id;
		if (isNonEmptyString(id)) result.push(id);
	}

	return result;
}

/**
 * Trims whitespace from each string and filters out empty results.
 * Replaces the common `.map(x => x.trim()).filter(Boolean)` chain.
 */
export function trimAndFilter(items: readonly string[]): string[] {
	const result: string[] = [];
	for (const item of items) {
		const trimmed = item.trim();
		if (trimmed.length > 0) result.push(trimmed);
	}

	return result;
}

/**
 * Groups items by a key derived from each item.
 * Items with null/undefined keys are omitted.
 */
export function groupBy<T, K extends string | number | symbol>(
	items: readonly T[],
	keySelector: (item: T) => K | null | undefined,
): Map<K, T[]>;

export function groupBy<T, K extends string | number | symbol, V>(
	items: readonly T[],
	keySelector: (item: T) => K | null | undefined,
	valueSelector: (item: T) => V,
): Map<K, V[]>;

export function groupBy<T, K extends string | number | symbol, V>(
	items: readonly T[],
	keySelector: (item: T) => K | null | undefined,
	valueSelector?: (item: T) => V,
): Map<K, Array<V | T>> {
	const map = new Map<K, Array<V | T>>();
	for (const item of items) {
		const key = keySelector(item);
		if (key == null) continue;

		const value = valueSelector ? valueSelector(item) : item;
		const existing = map.get(key);
		if (existing) {
			existing.push(value);
		} else {
			map.set(key, [value]);
		}
	}

	return map;
}
