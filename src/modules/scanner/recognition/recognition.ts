import type { MediaRecognitionCandidate } from "@sdk/plugin";
import { pluginsService } from "@/application/plugins.service";
import { recognitionService } from "@/modules/recognition/recognition.service";

export async function recognizeWithPluginHooks(
	filePath: string,
	transformCandidate?: typeof pluginsService.transformRecognitionCandidate,
): Promise<Awaited<ReturnType<typeof recognitionService.recognize>>> {
	const transform = transformCandidate ?? ((candidate) => pluginsService.transformRecognitionCandidate(candidate));

	const result = recognitionService.recognize(filePath);
	if (!result) return null;

	const candidate = await transform({
		type: result.type,
		title: result.identity.title,
		year: result.identity.year,
		season: result.identity.season,
		episode: result.identity.episode,
	});

	if (!isValidRecognitionCandidate(result.type, candidate)) return null;

	return {
		...result,
		identity: {
			title: candidate.title,
			type: candidate.type === "movie" ? "movie" : "episode",
			year: candidate.year,
			season: candidate.season,
			episode: candidate.episode,
		},
	};
}

function isValidRecognitionCandidate(type: "movie" | "tv_show", candidate: MediaRecognitionCandidate): boolean {
	if (candidate.type !== type || !candidate.title.trim()) return false;

	if (
		[candidate.year, candidate.season, candidate.episode].some((value) => value !== undefined && (!Number.isInteger(value) || value < 0))
	) {
		return false;
	}

	return candidate.type !== "tv_show" || (candidate.season !== undefined && candidate.episode !== undefined);
}
