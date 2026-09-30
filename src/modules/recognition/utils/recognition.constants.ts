export const YEAR_FOLDER_PATTERN = /^(?:19|20)\d{2}(?:-(?:19|20)?\d{2})?$/;

export const YEAR_TITLE_PATTERN = /^(?:19|20)\d{2}$/;

/** Matches SxxExx episode patterns (e.g. S01E02). Captures: group 1 = season, group 2 = episode. */
export const EPISODE_SXXEXX_PATTERN = /s(\d{1,2})e(\d{1,3})/i;

export const EPISODE_FILE_PATTERN =
	// The bare-number branch deliberately refuses `_` as its leading separator:
	// a `_001`-style suffix marks a duplicate/part of the same title, not an
	// episode (dot/space/hyphen separators still produce episodes). The `(?!\d)`
	// range tail keeps `01-1080p` from reading as the range `01-10`.
	/(?:s(?<season>\d{1,2})e(?<episode>\d{1,2})(?:[-_. ]{1,2}e?(?<range_end>\d{1,2})(?!\d))?|(?<season_alt>\d{1,2})x(?<episode_alt>\d{1,2})(?:[-_. ]{1,2}e?(?<range_end_alt>\d{1,2})(?!\d))?|(?:^|[\s.-])(?:e|ep|odcinek)?[\s.-]*(?<episode_only>\d{1,3})(?:[-_. ]{1,2}e?(?<range_end_only>\d{1,3})(?!\d))?(?:[\s._-]|$))/i;
