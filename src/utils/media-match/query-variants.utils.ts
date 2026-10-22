import { unique } from "@/utils/array.utils";
import { EDITION_NOISE } from "@/utils/release-tags.constants";
import { LEADING_THE, WHITESPACE_COLLAPSE } from "./normalize.utils";

const PUNCTUATION_COLLAPSE = /[.:_]+|\s+/g;
const AND_WORD_GLOBAL = /\band\b/gi;
// Recognition leftovers like "Show (2011) -" (dash kept from " - S01E01 - ") must
// never reach provider search — strip the year/separator tail as an extra variant.
const TRAILING_YEAR_TAIL = /\s*\((?:19|20)\d{2}\)?\s*[-–—]?\s*$/;

/**
 * Generates alternate phrasings of a title so a provider search that misses on the raw string
 * still has a chance to surface the right candidate (different punctuation, "&" vs "and", "The" prefix).
 */
export function generateQueryVariants(title: string): string[] {
	const trimmed = title.trim();
	const withoutEdition = trimmed.replace(EDITION_NOISE, "").replace(WHITESPACE_COLLAPSE, " ").trim();
	const withoutPunctuation = trimmed.replaceAll(PUNCTUATION_COLLAPSE, " ").trim();
	const withoutTrailingYearTail = trimmed.replace(TRAILING_YEAR_TAIL, "").trim();
	const withoutLeadingThe = withoutPunctuation.replace(LEADING_THE, "");
	const swappedAmpersand = trimmed.includes("&") ? trimmed.replaceAll("&", "and") : trimmed.replaceAll(AND_WORD_GLOBAL, "&");

	return unique(
		[trimmed, withoutTrailingYearTail, withoutEdition, withoutPunctuation, withoutLeadingThe, swappedAmpersand].filter(Boolean),
	);
}
