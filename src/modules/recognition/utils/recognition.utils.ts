import type { MediaIdentity } from "@reelvault/sdk/common";
import { MemoryCache } from "@/utils/memory.cache";
import { SCENE_NOISE } from "@/utils/release-tags.constants";
import {
	BRACKETED_YEAR_PATTERN,
	EPISODE_FILE_PATTERN,
	IMDB_ID_PATTERN,
	LEADING_YEAR_PATTERN,
	PROVIDER_ID_TAG_CAPTURE_PATTERN,
	PROVIDER_ID_TAG_PATTERN,
	TMDB_ID_PATTERN,
	YEAR_FOLDER_PATTERN,
	YEAR_TITLE_PATTERN,
	YEAR_TOKEN_PATTERN,
} from "./recognition.constants";

const EXT_PATTERN = /\.(?:mkv|mp4|avi|mov|wmv|flv|webm|m4v|ts|m2ts|vob|ogv|divx|mpg|mpeg|iso|nfo|srt|sub|ass)$/i;
// `episodeMarker` captures the SxxExx / NxN marker with its optional range tail;
// the numbers themselves are parsed by `extractSeasonEpisode`.
const SERIES_PATTERN =
	/^(?:(?<title>.+?)(?:[\s._(-]+)(?:(?<year>(?:19|20)\d{2})(?:-(?:19|20)?\d{2})?)?(?:\))?(?:[\s._(-]+)?)?(?<episodeMarker>(?:s\d{1,3}e\d{1,4}(?!\d)|\d{1,2}x\d{1,2})(?:[-_. ]{1,2}e?\d{1,3}(?!\d))?)/i;
const DOT_UNDERSCORE_PATTERN = /[._]/g;
/** Separators and an opening bracket left dangling in front of the year that was cut off. */
const TITLE_TAIL_PATTERN = /[\s._([-]+$/;

function cleanTitle(str: string): string {
	return str.replace(DOT_UNDERSCORE_PATTERN, " ").replace(/\s+/g, " ").trim();
}

/**
 * Memoized: a season folder re-parses the same show/folder names once per
 * episode file (up to 4 regex passes per file). Cache holds the parsed result;
 * callers get a shallow copy so they can never mutate the cached entry.
 */
const NO_MATCH = Symbol("NO_MATCH");
const parseCache = new MemoryCache<MediaIdentity | typeof NO_MATCH>({ ttlMs: -1, maxSize: 10_000, name: "parse" });

export function parseFileName(fileName: string): MediaIdentity | null {
	const cached = parseCache.get(fileName);
	if (cached !== null) {
		return cached === NO_MATCH ? null : { ...cached };
	}

	const parsed = parseFileNameUncached(fileName);
	parseCache.set(fileName, parsed ?? NO_MATCH);

	return parsed ? { ...parsed } : null;
}

function parseFileNameUncached(fileName: string): MediaIdentity | null {
	const nameWithoutExt = fileName.replace(EXT_PATTERN, "").replace(PROVIDER_ID_TAG_PATTERN, "");

	// 1. Series marker (SxxExx / NxN): title/year come from the anchored
	// pattern, the season/episode numbers from the shared extractor.
	const seriesMatch = nameWithoutExt.match(SERIES_PATTERN);
	if (seriesMatch?.groups) {
		const { title, year, episodeMarker } = seriesMatch.groups;
		const { season, episode, episodeEnd } = extractSeasonEpisode(episodeMarker ?? "");

		if (episode !== undefined) {
			return {
				title: cleanTitle(title ?? nameWithoutExt),
				type: "episode",
				season,
				episode,
				...(episodeEnd === undefined ? {} : { episodeEnd }),
				year: year ? Number.parseInt(year, 10) : undefined,
			};
		}
	}

	// 2. If no season was found, look for a movie with a year
	const movie = parseMovieWithYear(nameWithoutExt);
	if (movie) return movie;

	// 3. Fallback — no year and no season pattern in the name: strip scene noise and treat the rest as the title
	const stripped = nameWithoutExt.replace(SCENE_NOISE, "").trim();
	const title = cleanTitle(stripped || nameWithoutExt);
	if (!title) return null;

	return {
		title,
		type: "movie",
		year: undefined,
	};
}

/**
 * Movie names that carry a year: `Title (YYYY) ...` / `Title.YYYY.1080p...` (the LAST year before
 * the scene noise wins, so "Blade Runner 2049 (2017)" is the 2017 film) and year-first names such as
 * `(1993) Title` / `1993 - Title`.
 */
function parseMovieWithYear(name: string): MediaIdentity | null {
	const leading = name.match(LEADING_YEAR_PATTERN)?.groups;
	const leadingTitle = leading?.title?.replace(SCENE_NOISE, "");
	if (leading && leadingTitle && !BRACKETED_YEAR_PATTERN.test(leadingTitle)) {
		const title = cleanTitle(leadingTitle);
		if (title) return { title, type: "movie", year: Number.parseInt(leading.parenYear ?? leading.dashYear ?? "", 10) };
	}

	const head = name.replace(SCENE_NOISE, "");
	let lastYear: RegExpExecArray | undefined;
	for (const match of head.matchAll(YEAR_TOKEN_PATTERN)) lastYear = match;

	if (lastYear?.index === undefined || !lastYear.groups?.year) return null;

	const title = cleanTitle(head.slice(0, lastYear.index).replace(TITLE_TAIL_PATTERN, ""));
	if (!title) return null;

	return { title, type: "movie", year: Number.parseInt(lastYear.groups.year, 10) };
}

/**
 * Season/episode numbers extracted straight from a file name via
 * `EPISODE_FILE_PATTERN` — the single number parser, used by `parseFileName`
 * (on the matched marker tail) and as the fallback both series strategies use
 * when `parseFileName` found no SxxExx marker. Covers every named group.
 *
 * Memoized: both series strategies run this on the same file name before the
 * movie strategies get their turn, so movie layouts would otherwise pay the
 * regex twice per file.
 */
const extractCache = new MemoryCache<{ season?: number; episode?: number; episodeEnd?: number }>({
	ttlMs: -1,
	maxSize: 10_000,
	name: "extract-episode",
});

export function extractSeasonEpisode(fileName: string): { season?: number; episode?: number; episodeEnd?: number } {
	const cached = extractCache.get(fileName);
	if (cached !== null) return { ...cached };

	const result = extractSeasonEpisodeUncached(fileName);
	extractCache.set(fileName, result);

	return result;
}

function extractSeasonEpisodeUncached(fileName: string): { season?: number; episode?: number; episodeEnd?: number } {
	const match = fileName.match(EPISODE_FILE_PATTERN);
	if (!match?.groups) return {};

	const { season, season_alt, episode, episode_alt, episode_only, range_end, range_end_alt, range_end_only } = match.groups;
	const seasonStr = season ?? season_alt;
	const episodeStr = episode ?? episode_alt ?? episode_only;
	const endStr = range_end ?? range_end_alt ?? range_end_only;
	const episodeNumber = episodeStr ? Number.parseInt(episodeStr, 10) : undefined;
	const endNumber = endStr ? Number.parseInt(endStr, 10) : undefined;

	return {
		...(seasonStr ? { season: Number.parseInt(seasonStr, 10) } : {}),
		...(episodeNumber === undefined ? {} : { episode: episodeNumber }),
		...(episodeNumber !== undefined && endNumber !== undefined && endNumber > episodeNumber ? { episodeEnd: endNumber } : {}),
	};
}

/**
 * Resolves the season/episode numbers a series strategy should use for a file:
 * the parsed identity first, then the episode extractor as fallback, with the
 * enclosing season folder as the last season source.
 */
export function resolveEpisodeNumbers(
	fileName: string,
	fileIdentity: MediaIdentity | null,
	folderSeason?: number,
): { season?: number | undefined; episode?: number | undefined; episodeEnd?: number | undefined } {
	let season = fileIdentity?.season ?? folderSeason;
	let episode = fileIdentity?.episode;
	let episodeEnd = fileIdentity?.episodeEnd;

	if (episode === undefined) {
		const extracted = extractSeasonEpisode(fileName);
		season ??= extracted.season;
		episode = extracted.episode;
		episodeEnd = extracted.episodeEnd;
	}

	return { season, episode, episodeEnd };
}

/** Upper bound on episodes a single file may claim — longer "ranges" are scene noise. */
export const MAX_EPISODE_RANGE_SPAN = 12;

/**
 * Episodes covered by the identity when it names a range (S01E03-E05 → 3).
 * `undefined` for movies, single episodes, descending and over-long ranges.
 */
export function episodeRangeSpan(identity: MediaIdentity | null | undefined): number | undefined {
	if (identity?.type !== "episode" || identity.episode === undefined) return undefined;

	const span = (identity.episodeEnd ?? identity.episode) - identity.episode + 1;
	if (span <= 1 || span > MAX_EPISODE_RANGE_SPAN) return undefined;

	return span;
}

/**
 * Episode numbers covered by the parsed identity: `[3]` for a plain SxxExx
 * file, `[3, 4, 5]` for S01E03-E05. `undefined` when the file is not a
 * multi-episode candidate (movies, single episodes, malformed ranges).
 */
export function episodeRangeTargets(identity: MediaIdentity | null | undefined): number[] | undefined {
	const span = episodeRangeSpan(identity);
	if (span === undefined || identity?.episode === undefined) return undefined;

	const start = identity.episode;

	return Array.from({ length: span }, (_, index) => start + index);
}

/**
 * The TMDB and IMDb ids a media manager named in the path (`[tmdbid-329]`, `{imdb-tt0107290}`). The parts are
 * checked nearest first, so a file's own name beats its folders; the first valid id of each provider wins.
 */
export function extractPathProviderIds(parts: readonly string[]): Record<string, string> {
	const ids: Record<string, string> = {};
	for (const part of parts.toReversed()) {
		for (const match of part.matchAll(PROVIDER_ID_TAG_CAPTURE_PATTERN)) {
			const provider = match.groups?.provider?.toLowerCase();
			const id = match.groups?.id ?? "";
			if (provider === "tmdb" && ids.tmdb === undefined && TMDB_ID_PATTERN.test(id)) ids.tmdb = id;
			if (provider === "imdb" && ids.imdb === undefined && IMDB_ID_PATTERN.test(id)) ids.imdb = id.toLowerCase();
		}
	}

	return ids;
}

/** Shared title-resolution logic used by both series-basic and series-categorized strategies. */
export function resolveShowTitle(
	showIdentity: MediaIdentity,
	fileIdentity: MediaIdentity | null,
): { title: string; year: number | undefined } {
	let title = showIdentity.title;
	const year = showIdentity.year ?? fileIdentity?.year;
	if (YEAR_FOLDER_PATTERN.test(title) && fileIdentity?.title && !YEAR_TITLE_PATTERN.test(fileIdentity.title)) {
		title = fileIdentity.title;
	} else if (
		fileIdentity?.title &&
		fileIdentity.title.length > title.length &&
		fileIdentity.title.toLowerCase().startsWith(title.toLowerCase())
	) {
		title = fileIdentity.title;
	}

	return { title, year };
}
