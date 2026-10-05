import { normalizeLower } from "@/utils/type.utils";

/** Trims/lowercases string entries, drops blanks, then dedupes and sorts. */
export function normalizeStringList(values: readonly unknown[]): string[] {
	const normalized = new Set<string>();
	for (const value of values) {
		if (typeof value !== "string") continue;

		const trimmed = normalizeLower(value);
		if (trimmed) normalized.add(trimmed);
	}

	return [...normalized].toSorted();
}
