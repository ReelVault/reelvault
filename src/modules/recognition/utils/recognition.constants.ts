export const YEAR_FOLDER_PATTERN = /^(?:19|20)\d{2}(?:-(?:19|20)?\d{2})?$/;

export const YEAR_TITLE_PATTERN = /^(?:19|20)\d{2}$/;

/** Matches SxxExx episode patterns (e.g. S01E02). Captures: group 1 = season, group 2 = episode. */
export const EPISODE_SXXEXX_PATTERN = /s(\d{1,2})e(\d{1,3})/i;

export const EPISODE_FILE_PATTERN =
	/(?:s(?<season>\d{1,2})e(?<episode>\d{1,2})|(?<season_alt>\d{1,2})x(?<episode_alt>\d{1,2})|(?:^|[\s._-])(?:e|ep|odcinek)?[\s._-]*(?<episode_only>\d{1,3})(?:[\s._-]|$))/i;
