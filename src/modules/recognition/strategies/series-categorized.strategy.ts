import type { PathContext, RecognitionResult, RecognitionStrategy } from "../recognition.types";
import { parseFileName, resolveEpisodeNumbers, resolveShowTitle } from "../utils/recognition.utils";

const SEASON_FOLDER_PATTERN = /^(?:Season|Sezon|S)\s*\d+|^Specials$/i;
const SEASON_FOLDER_MATCH_PATTERN = /^(?:Season|Sezon|S)\s*(\d+)/i;
const SPECIALS_FOLDER_PATTERN = /^Specials$/i;

export class SeriesCategorizedStrategy implements RecognitionStrategy {
	readonly name = "series-categorized";

	recognize(ctx: PathContext): RecognitionResult | null {
		const { grandParentFolder, parentFolder, fileName } = ctx;
		if (!(grandParentFolder && parentFolder && fileName)) return null;

		if (!SEASON_FOLDER_PATTERN.test(parentFolder)) return null;

		const showIdentity = parseFileName(grandParentFolder);
		if (!showIdentity) return null;

		let folderSeason: number | undefined;
		const folderMatch = parentFolder.match(SEASON_FOLDER_MATCH_PATTERN);
		if (folderMatch?.[1]) {
			folderSeason = Number.parseInt(folderMatch[1], 10);
		} else if (SPECIALS_FOLDER_PATTERN.test(parentFolder)) {
			folderSeason = 0;
		}

		const fileIdentity = parseFileName(fileName);
		const { season, episode, episodeEnd } = resolveEpisodeNumbers(fileName, fileIdentity, folderSeason);

		if (season === undefined || episode === undefined) return null;

		// A season folder anchors the show, so a year in the episode file name is
		// the season's year (e.g. "S05" aired 2024) — never use it against the show.
		const { title, year } = resolveShowTitle(showIdentity, fileIdentity && { ...fileIdentity, year: undefined });

		return {
			type: "tv_show",
			identity: { title, year, type: "episode", season, episode, ...(episodeEnd !== undefined ? { episodeEnd } : {}) },
		};
	}
}
