import type { MediaIdentity } from "@sdk/common/media";
import { MemoryCache } from "@/utils/memory-cache";
import { EPISODE_FILE_PATTERN, YEAR_FOLDER_PATTERN, YEAR_TITLE_PATTERN } from "./recognition.constants";

const EXT_PATTERN = /\.(?:mkv|mp4|avi|mov|wmv|flv|webm|m4v|ts|m2ts|vob|ogv|divx|mpg|mpeg|iso|nfo|srt|sub|ass)$/i;
const SERIES_PATTERN =
	/^(?:(?<title>.+?)(?:[\s._(]+)(?:(?<year>(?:19|20)\d{2})(?:-(?:19|20)?\d{2})?)?(?:\))?(?:[\s._(]+)?)?(?:s(?<season>\d{1,2})e(?<episode>\d{1,2})|(?<season_alt>\d{1,2})x(?<episode_alt>\d{1,2}))/i;
const MOVIE_PATTERN = /^(?<title>.+?)(?:[\s._(]+)(?<year>(?:19|20)\d{2})(?:-(?:19|20)?\d{2})?/i;
const DOT_UNDERSCORE_PATTERN = /[._]/g;

function cleanTitle(str: string): string {
	return str.replace(DOT_UNDERSCORE_PATTERN, " ").replace(/\s+/g, " ").trim();
}

const SCENE_NOISE_PATTERN =
	/\b(?:2160p|1080p|1080i|720p|480p|4k|uhd|bluray|bdrip|brrip|web[-_. ]?dl|webrip|hdrip|dvdrip|remux|h264|h265|x264|x265|hevc|avc|10bit|ddp[57]\.1|truehd|atmos|aac(?:\d\.\d)?|ac3|dts(?:-hd)?|flac|multi|dubbed|lektor|subbed|repack|proper|extended|unrated|directors\.cut)\b.*$/i;

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
	const nameWithoutExt = fileName.replace(EXT_PATTERN, "");

	// 1. Najpierw szukamy wzorca serialu (S01E01 lub 1x01)
	const seriesMatch = nameWithoutExt.match(SERIES_PATTERN);
	if (seriesMatch?.groups) {
		const { title, year, season, episode, season_alt, episode_alt } = seriesMatch.groups;

		return {
			title: cleanTitle(title ?? nameWithoutExt),
			type: "episode",
			season: Number.parseInt(season ?? season_alt ?? "0", 10),
			episode: Number.parseInt(episode ?? episode_alt ?? "0", 10),
			year: year ? Number.parseInt(year, 10) : undefined,
		};
	}

	// 2. If no season was found, look for a movie with a year
	const movieMatch = nameWithoutExt.match(MOVIE_PATTERN);

	if (movieMatch?.groups) {
		const { title, year } = movieMatch.groups;
		if (!title) return null;

		return {
			title: cleanTitle(title),
			type: "movie",
			year: year ? Number.parseInt(year, 10) : undefined,
		};
	}

	// 3. Fallback — no year and no season pattern in the name: strip scene noise and treat the rest as the title
	const stripped = nameWithoutExt.replace(SCENE_NOISE_PATTERN, "").trim();
	const title = cleanTitle(stripped || nameWithoutExt);
	if (!title) return null;

	return {
		title,
		type: "movie",
		year: undefined,
	};
}

/**
 * Season/episode numbers extracted straight from a file name via
 * `EPISODE_FILE_PATTERN` — the fallback both series strategies use when
 * `parseFileName` found no SxxExx marker. Covers every named group.
 */
export function extractSeasonEpisode(fileName: string): { season?: number; episode?: number } {
	const match = fileName.match(EPISODE_FILE_PATTERN);
	if (!match?.groups) return {};

	const { season, season_alt, episode, episode_alt, episode_only } = match.groups;
	const seasonStr = season ?? season_alt;
	const episodeStr = episode ?? episode_alt ?? episode_only;

	return {
		...(seasonStr ? { season: Number.parseInt(seasonStr, 10) } : {}),
		...(episodeStr ? { episode: Number.parseInt(episodeStr, 10) } : {}),
	};
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
