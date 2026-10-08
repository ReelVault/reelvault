/**
 * Shared release-tag vocabulary for everything that reads tags out of file
 * names: the probe mapper (source/edition/quality), title matching (edition
 * noise), recognition (scene noise) and sidecar slugs. Keeping the lists and
 * the normalizer in one place stops the consumers from drifting apart.
 */

export interface ReleaseTagDefinition {
	value: string;
	aliases: readonly string[];
}

export interface ResolutionBucket {
	readonly label: string;
	readonly minWidth: number;
}

/** Source tags in priority order — the first match wins. */
export const SOURCE_TAGS: readonly ReleaseTagDefinition[] = [
	{ value: "WEB-DL", aliases: ["web-dl", "web dl", "webrip", "web rip"] },
	{ value: "BluRay", aliases: ["bluray", "blu-ray", "blu ray", "bdrip", "bd-rip", "bd rip", "brrip", "br-rip", "br rip"] },
	{ value: "Remux", aliases: ["remux"] },
	{ value: "HDTV", aliases: ["hdtv"] },
	{ value: "DVD", aliases: ["dvd", "dvdrip", "dvd-rip", "dvd rip"] },
	{ value: "VHS", aliases: ["vhs"] },
	{ value: "CAM", aliases: ["cam"] },
	{ value: "TS", aliases: ["ts", "telesync"] },
	{ value: "TC", aliases: ["tc", "telecine"] },
];

/** Edition tags; every matching tag is joined into the stored edition label. */
export const EDITION_TAGS: readonly ReleaseTagDefinition[] = [
	{ value: "Director's Cut", aliases: ["director's cut", "directors cut", "director cut"] },
	{ value: "Special Edition", aliases: ["special edition"] },
	{ value: "Collector's Edition", aliases: ["collector's edition", "collectors edition"] },
	{ value: "Extended", aliases: ["extended", "extended cut"] },
	{ value: "Remastered", aliases: ["remastered", "remaster"] },
	{ value: "Unrated", aliases: ["unrated"] },
	{ value: "Theatrical", aliases: ["theatrical cut", "theatrical"] },
	{ value: "IMAX", aliases: ["imax"] },
	{ value: "Anniversary", aliases: ["anniversary"] },
	{ value: "Ultimate", aliases: ["ultimate edition", "ultimate"] },
	{ value: "Final Cut", aliases: ["final cut"] },
	{ value: "Open Matte", aliases: ["open matte"] },
];

/** Width buckets a video stream is classified into — first bucket whose minWidth fits. */
export const RESOLUTION_BUCKETS: readonly ResolutionBucket[] = [
	{ label: "4320p", minWidth: 7000 },
	{ label: "2160p", minWidth: 3200 },
	{ label: "1440p", minWidth: 2300 },
	{ label: "1080p", minWidth: 1800 },
	{ label: "720p", minWidth: 1200 },
	{ label: "576p", minWidth: 900 },
	{ label: "480p", minWidth: 700 },
	{ label: "360p", minWidth: 500 },
	{ label: "240p", minWidth: 0 },
];

/**
 * Edition phrasings stripped from titles before provider matching. Curated for
 * title noise — intentionally not generated from `EDITION_TAGS`: deriving it
 * would start stripping "collector's edition"/"anniversary"/bare "ultimate"
 * and drop "theatrical version"/"unrated cut", changing match scores.
 */
export const EDITION_NOISE =
	/\b(?:directors?\s+cut|extended(?:\s+cut|\s+edition)?|theatrical(?:\s+cut|\s+version)?|unrated(?:\s+cut|\s+version)?|remastered|imax(?:\s+edition)?|special\s+edition|final\s+cut|ultimate\s+cut)\b/gi;

/**
 * Scene-release suffix stripped by the recognition fallback: from the first
 * noise token to the end of the name. Curated from the source/resolution
 * vocabulary plus codec, audio and language tags — deriving it from
 * `SOURCE_TAGS`/`RESOLUTION_BUCKETS` would add aliases (e.g. "blu ray",
 * "240p") that must keep their title meaning today.
 */
export const SCENE_NOISE =
	/\b(?:2160p|1080p|1080i|720p|480p|4k|uhd|bluray|bdrip|brrip|web[-_. ]?dl|webrip|hdrip|dvdrip|remux|h264|h265|x264|x265|hevc|avc|10bit|ddp[57]\.1|truehd|atmos|aac(?:\d\.\d)?|ac3|dts(?:-hd)?|flac|multi|dubbed|lektor|subbed|repack|proper|extended|unrated|directors\.cut)\b.*$/i;

/** Folder names that carry no title information for the categorized movie and series-basic strategies. */
export const GENERIC_FOLDER_NAMES =
	/^(?:movies|filmy|film|cinema|kino|downloads|pobrane|video|wideo|media|tv|tv\s?shows|shows|series|seriale|temp|complete|4k|1080p|720p|bluray|uhd|remux)$/i;

const NON_ALPHANUMERIC = /[^a-z0-9]+/g;

/** Lowercases and collapses every non-alphanumeric run into single spaces. */
export function normalizeForMatching(value: string): string {
	return value.toLowerCase().replace(NON_ALPHANUMERIC, " ").trim();
}
