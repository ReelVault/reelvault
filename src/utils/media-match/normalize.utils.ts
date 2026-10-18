import { MemoryCache } from "@/utils/memory.cache";
import { EDITION_NOISE } from "@/utils/release-tags.constants";

const DIACRITICS_PATTERN = /\p{M}/gu;

/** Strips Unicode combining marks (diacritics) from a string after NFD decomposition. */
export function stripDiacritics(value: string): string {
	return value.normalize("NFD").replace(DIACRITICS_PATTERN, "");
}

export const WHITESPACE_COLLAPSE = /\s+/g;
export const LEADING_THE = /^the\s+/i;

const STROKE_LETTER_REGEX = /[łŁđĐøØ]/g;
// NFD decomposition misses stroke letters (ł, Ł, đ, ø) — they have no
// combining-mark form and must be mapped explicitly.
const STROKE_LETTER_MAP: Record<string, string> = { ł: "l", Ł: "l", đ: "d", Đ: "d", ø: "o", Ø: "o" };
const TITLE_PUNCTUATION = /[.'".,:()[\]\-_/]+/g;

/** Lowercases and strips diacritics, mirroring the FTS5 `remove_diacritics 2` tokenizer. */
export function normalizeForFuzzy(value: string): string {
	const unstroked = value.replace(STROKE_LETTER_REGEX, (character) => STROKE_LETTER_MAP[character] ?? character);

	return stripDiacritics(unstroked.toLowerCase());
}

/** The words of a space-separated value, each once. */
export function splitToSet(value: string): Set<string> {
	const set = new Set<string>();
	let start = 0;
	for (let index = 0; index <= value.length; index++) {
		if (index === value.length || value.charCodeAt(index) === 32) {
			if (index > start) set.add(value.slice(start, index));

			start = index + 1;
		}
	}

	return set;
}

const ROMAN_NUMERALS: Record<string, string> = {
	i: "1",
	ii: "2",
	iii: "3",
	iv: "4",
	v: "5",
	vi: "6",
	vii: "7",
	viii: "8",
	ix: "9",
	x: "10",
};

// Bounded cache keyed by the raw title: provider results repeat heavily across searches.
const normalizeTitleCache = new MemoryCache<string>({ ttlMs: -1, maxSize: 2048, name: "normalize-title" });

/** Strips diacritics, punctuation, edition tags, a leading "the", and normalizes roman numerals so titles compare fairly across languages/formats. */
export function normalizeTitle(value: string): string {
	const cached = normalizeTitleCache.get(value);
	if (cached !== null) return cached;

	const withoutDiacritics = stripDiacritics(value).toLowerCase();
	const withoutEdition = withoutDiacritics.replace(EDITION_NOISE, " ");
	const withoutPunctuation = withoutEdition.replace(TITLE_PUNCTUATION, " ").replace(WHITESPACE_COLLAPSE, " ").trim();
	const withoutLeadingThe = withoutPunctuation.replace(LEADING_THE, "");
	const normalized = withoutLeadingThe
		.split(" ")
		.map((word) => ROMAN_NUMERALS[word] ?? word)
		.join(" ");

	normalizeTitleCache.set(value, normalized);

	return normalized;
}

/** The year a date text starts with (`2020`, `2020-05-01`); a longer digit run (`12345`) is no year. */
const YEAR_PREFIX_REGEX = /^(\d{4})(?!\d)/;

export function extractYear(date: string | undefined): number | undefined {
	const year = Number(YEAR_PREFIX_REGEX.exec(date ?? "")?.[1]);

	return year > 0 ? year : undefined;
}
