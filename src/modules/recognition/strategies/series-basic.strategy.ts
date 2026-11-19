import type { PathContext, RecognitionResult, RecognitionStrategy } from "@/modules/recognition/recognition.types";
import { createEpisodeResult, parseFileName, resolveFileEpisode, resolveShowTitle } from "@/modules/recognition/utils/recognition.utils";
import { GENERIC_FOLDER_NAMES } from "@/utils/release-tags.constants";

export const seriesBasicStrategy: RecognitionStrategy = {
	recognize(ctx: PathContext): RecognitionResult | null {
		const { parentFolder, fileName } = ctx;
		if (!(parentFolder && fileName)) return null;

		// Resolve the file's episode numbers first: a movie file bails out here
		// without paying for the show-folder parse.
		const episodeFile = resolveFileEpisode(fileName);
		if (!episodeFile) return null;

		const showIdentity = parseFileName(parentFolder);
		if (!showIdentity) return null;

		const { fileIdentity, season, episode, episodeEnd } = episodeFile;
		// A generic folder ("movies", "downloads", "tv") is a library root, not the
		// show name — the episode file carries the title (mirrors movies-categorized).
		const { title, year } = GENERIC_FOLDER_NAMES.test(parentFolder.trim())
			? { title: fileIdentity?.title ?? showIdentity.title, year: fileIdentity?.year }
			: resolveShowTitle(showIdentity, fileIdentity);

		return createEpisodeResult({ title, year, season, episode, episodeEnd });
	},
};
