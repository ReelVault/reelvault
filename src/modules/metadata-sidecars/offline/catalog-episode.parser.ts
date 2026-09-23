import { EPISODE_SXXEXX_PATTERN } from "@/modules/recognition/utils/recognition.constants";

export interface ParsedEpisodeNumbers {
	readonly season: number;
	readonly number: number;
}

export function parseEpisode(fileName: string): ParsedEpisodeNumbers | undefined {
	const match = EPISODE_SXXEXX_PATTERN.exec(fileName);

	return match ? { season: Number(match[1]), number: Number(match[2]) } : undefined;
}
