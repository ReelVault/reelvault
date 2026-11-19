import type { PathContext, RecognitionResult, RecognitionStrategy } from "@/modules/recognition/recognition.types";
import {
	createEpisodeResult,
	parseFileName,
	readSeasonFolderNumber,
	resolveFileEpisode,
	resolveShowTitle,
} from "@/modules/recognition/utils/recognition.utils";
import { GENERIC_FOLDER_NAMES } from "@/utils/release-tags.constants";

export const seriesCategorizedStrategy: RecognitionStrategy = {
	recognize(ctx: PathContext): RecognitionResult | null {
		const { grandParentFolder, parentFolder, fileName } = ctx;
		if (!(grandParentFolder && parentFolder && fileName)) return null;

		const folderSeason = readSeasonFolderNumber(parentFolder);
		if (folderSeason === undefined) return null;

		const episodeFile = resolveFileEpisode(fileName, folderSeason);
		if (!episodeFile) return null;

		const showIdentity = parseFileName(grandParentFolder);
		if (!showIdentity) return null;

		const { fileIdentity, season, episode, episodeEnd } = episodeFile;
		// A generic grandparent ("tv", "downloads") is a library root, not the show name: the episode file carries the title.
		if (GENERIC_FOLDER_NAMES.test(grandParentFolder.trim())) {
			return createEpisodeResult({
				title: fileIdentity?.title ?? showIdentity.title,
				year: fileIdentity?.year,
				season,
				episode,
				episodeEnd,
			});
		}

		// Otherwise a season folder anchors the show, so a year in the episode file name is the season's year
		// (e.g. "S05" aired 2024) — never use it against the show.
		const { title, year } = resolveShowTitle(showIdentity, fileIdentity && { ...fileIdentity, year: undefined });

		return createEpisodeResult({ title, year, season, episode, episodeEnd });
	},
};
