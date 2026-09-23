import type { FFProbeChapter } from "@/integrations/ffprobe/ffprobe.types";
import { serverConfig } from "@/server.config";
import { stripDiacritics } from "@/utils/media-match.utils";
import { MemoryCache } from "@/utils/memory-cache";
import { parseColonSeparatedSeconds } from "@/utils/time.utils";
import { isFiniteNumber, normalizeLower } from "@/utils/type.utils";

export type AutomaticMarkerType = "intro" | "credits" | "recap";

export interface ChapterMarkerDraft {
	type: AutomaticMarkerType;
	startSeconds: number;
	endSeconds: number;
	label: string | null;
}

export interface MarkerKeywords {
	intro: string[];
	credits: string[];
	recap: string[];
}

const MIN_MARKER_SECONDS = 8;
const MAX_MARKER_SECONDS = 15 * 60;
const CHAPTER_WORD_SEPARATOR_RE = /[\s:,;·•\-–—()[\].]+/;

const normalizeKeyword = (w: string): string => stripDiacritics(normalizeLower(w));

const wordToTypeCache = new MemoryCache<Map<string, AutomaticMarkerType>>({
	ttlMs: -1,
	maxSize: 1,
	name: "chapter-keywords",
});

function getWordToTypeMap(keywords: MarkerKeywords): Map<string, AutomaticMarkerType> {
	const key = `${keywords.intro.join(",")}|${keywords.credits.join(",")}|${keywords.recap.join(",")}`;
	const cached = wordToTypeCache.get(key);
	if (cached) return cached;

	const map = new Map<string, AutomaticMarkerType>();
	const addWords = (type: AutomaticMarkerType, words: string[]) => {
		for (const word of words) map.set(word, type);
	};
	addWords("intro", keywords.intro.map(normalizeKeyword));
	addWords("credits", keywords.credits.map(normalizeKeyword));
	addWords("recap", keywords.recap.map(normalizeKeyword));
	wordToTypeCache.set(key, map);

	return map;
}

function defaultKeywords(): MarkerKeywords {
	return {
		intro: serverConfig.markers.introKeywords,
		credits: serverConfig.markers.creditsKeywords,
		recap: serverConfig.markers.recapKeywords,
	};
}

function firstWord(normalizedTitle: string): string {
	return normalizedTitle.split(CHAPTER_WORD_SEPARATOR_RE).find(Boolean) ?? "";
}

/**
 * Maps named container chapters (MKV/MP4) to intro/credits/recap markers by
 * matching the chapter's FIRST word against the configured keyword lists
 * (`markers.*Keywords` settings — defaults are English; add your language's
 * terms in the admin panel). Matching is case- and diacritics-insensitive.
 * Chapters without a usable title are skipped — this is a heuristic, not
 * detection; the caller replaces only `source: "automatic"` markers, so manual
 * and plugin markers are never touched.
 */
export function mapChaptersToMarkers(
	chapters: readonly FFProbeChapter[],
	keywords: MarkerKeywords = defaultKeywords(),
): ChapterMarkerDraft[] {
	const wordToType = getWordToTypeMap(keywords);

	const drafts: ChapterMarkerDraft[] = [];
	for (const chapter of chapters) {
		const title = chapter.tags?.title;
		if (!title) continue;

		const normalized = normalizeLower(title);
		if (!normalized) continue;

		const word = firstWord(stripDiacritics(normalized));

		const type = wordToType.get(word);
		if (!type) continue;

		const startSeconds = parseColonSeparatedSeconds(chapter.start_time);
		const endSeconds = parseColonSeparatedSeconds(chapter.end_time);
		if (!(isFiniteNumber(startSeconds) && isFiniteNumber(endSeconds))) continue;

		const duration = endSeconds - startSeconds;
		if (startSeconds < 0 || duration < MIN_MARKER_SECONDS || duration > MAX_MARKER_SECONDS) continue;

		drafts.push({ type, startSeconds, endSeconds, label: title.trim() });
	}

	return drafts.toSorted((left, right) => left.startSeconds - right.startSeconds);
}
