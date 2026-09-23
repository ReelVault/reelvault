import type { PathContext, RecognitionResult, RecognitionStrategy } from "../recognition.types";
import { extractSeasonEpisode, parseFileName, resolveShowTitle } from "../utils/recognition.utils";

const SERIES_EPISODE_PATTERN = /s\d{1,2}e\d{1,2}|\d{1,2}x\d{1,2}/i;

export class SeriesBasicStrategy implements RecognitionStrategy {
	readonly name = "series-basic";

	recognize(ctx: PathContext): RecognitionResult | null {
		const { parentFolder, fileName } = ctx;
		if (!(parentFolder && fileName)) return null;

		if (!SERIES_EPISODE_PATTERN.test(fileName)) return null;

		const showIdentity = parseFileName(parentFolder);
		if (!showIdentity) return null;

		const fileIdentity = parseFileName(fileName);
		let season = fileIdentity?.season;
		let episode = fileIdentity?.episode;

		if (season === undefined || episode === undefined) {
			const extracted = extractSeasonEpisode(fileName);
			season ??= extracted.season;
			episode ??= extracted.episode;
		}

		if (season === undefined || episode === undefined) return null;

		const { title, year } = resolveShowTitle(showIdentity, fileIdentity);

		return {
			type: "tv_show",
			identity: { title, year, type: "episode", season, episode },
			meta: { libraryStructure: this.name, rootPath: parentFolder },
		};
	}
}
