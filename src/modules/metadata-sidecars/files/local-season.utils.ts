const SEASON_DIR_REGEX = /season\s*(\d{1,2})/i;

/** Season number encoded in a directory or file name (`Season 3`, `season03`). */
export function readSeasonNumber(name: string): number | undefined {
	const match = SEASON_DIR_REGEX.exec(name);

	return match ? Number(match[1]) : undefined;
}
