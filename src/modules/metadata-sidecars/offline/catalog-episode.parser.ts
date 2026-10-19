import { extractSeasonEpisode } from "@/modules/recognition/utils/recognition.utils";

export interface ParsedEpisodeNumbers {
	readonly season: number;
	readonly number: number;
}

/** Season and episode a file name carries, through the same parser online recognition uses. */
export function parseEpisode(fileName: string): ParsedEpisodeNumbers | undefined {
	const { season, episode } = extractSeasonEpisode(fileName);
	if (season === undefined || episode === undefined) return undefined;

	return { season, number: episode };
}
