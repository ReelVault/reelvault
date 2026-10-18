export const YEAR_FOLDER_PATTERN = /^(?:19|20)\d{2}(?:-(?:19|20)?\d{2})?$/;

export const YEAR_TITLE_PATTERN = /^(?:19|20)\d{2}$/;

/** Provider id tags media managers append to names, e.g. `[tmdbid-329]`, `{imdb-tt0107290}`, `(tvdbid=121361)`. */
export const PROVIDER_ID_TAG_PATTERN = /\s*[[{(]\s*(?:tmdb|tvdb|imdb|anidb)(?:id)?[\s:=-]*[a-z0-9]+\s*[\]})]/gi;

/** The provider and id a tag carries: `[tmdbid-329]` → tmdb / 329, `{imdb-tt0107290}` → imdb / tt0107290. */
export const PROVIDER_ID_TAG_CAPTURE_PATTERN = /[[{(]\s*(?<provider>tmdb|imdb)(?:id)?[\s:=-]*(?<id>[a-z0-9]+)\s*[\]})]/gi;

export const TMDB_ID_PATTERN = /^\d+$/;

export const IMDB_ID_PATTERN = /^tt\d+$/i;

/** A standalone year token: not glued to other characters and not the tail of a `1999-2005` range. */
export const YEAR_TOKEN_PATTERN = /(?<=^|[\s._([])(?<year>(?:19|20)\d{2})(?=$|[\s._)\]-])/g;

/** A parenthesised or bracketed year such as `(1968)` — the conventional release-year spot. */
export const BRACKETED_YEAR_PATTERN = /[([](?:19|20)\d{2}[)\]]/;

/** Year-first movie names: `(1993) Jurassic Park` and `1993 - Jurassic Park`. */
export const LEADING_YEAR_PATTERN = /^(?:\((?<parenYear>(?:19|20)\d{2})\)|(?<dashYear>(?:19|20)\d{2})\s+-)\s*(?<title>.+)$/;

/** Matches SxxExx episode patterns (e.g. S01E02, S012E03). Captures: group 1 = season, group 2 = episode. */
export const EPISODE_SXXEXX_PATTERN = /s(\d{1,3})e(\d{1,3})/i;

export const EPISODE_FILE_PATTERN =
	// The bare-number branch deliberately refuses `_` as its leading separator:
	// a `_001`-style suffix marks a duplicate/part of the same title, not an
	// episode (dot/space/hyphen separators still produce episodes). The `(?!\d)`
	// range tail keeps `01-1080p` from reading as the range `01-10`. Seasons
	// allow three digits (`S012E03`, season 12). Episodes allow four digits
	// (`S01E1000`, One Piece); a bare number reaches four digits only after an
	// `E`/`EP`/`odcinek` prefix or a dash (`One.Piece.E1000`, `One Piece - 1000`),
	// so a year such as `Blade.Runner.2049` stays a non-episode. The `(?!\d)`
	// after an episode refuses a five-digit run instead of truncating it.
	/(?:s(?<season>\d{1,3})e(?<episode>\d{1,4})(?!\d)(?:[-_. ]{1,2}e?(?<range_end>\d{1,3})(?!\d))?|(?<season_alt>\d{1,2})x(?<episode_alt>\d{1,2})(?:[-_. ]{1,2}e?(?<range_end_alt>\d{1,2})(?!\d))?|(?:^|[\s.-])(?:e|ep|odcinek)?[\s.-]*(?<episode_only>(?<=(?:^|[\s.-])(?:e|ep|odcinek)[\s.-]*|-[\s.-]*)\d{1,4}|\d{1,3})(?:[-_. ]{1,2}e?(?<range_end_only>\d{1,3})(?!\d))?(?:[\s._-]|$))/i;
