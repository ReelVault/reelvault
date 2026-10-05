import type { MediaRecognitionCandidate } from "@reelvault/sdk/plugin";
import { recognitionService } from "@/modules/recognition/recognition.service";
import { pluginHookBus } from "@/plugins/runtime/plugin.hooks";

export async function recognizeWithPluginHooks(filePath: string): Promise<Awaited<ReturnType<typeof recognitionService.recognize>>> {
	const result = recognitionService.recognize(filePath);
	if (!result) return null;

	const candidate = await pluginHookBus.runBeforeMediaRecognition({
		type: result.type,
		title: result.identity.title,
		year: result.identity.year,
		season: result.identity.season,
		episode: result.identity.episode,
		episodeEnd: result.identity.episodeEnd,
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
			episodeEnd: candidate.episodeEnd,
		},
	};
}

function isValidRecognitionCandidate(type: "movie" | "tv_show", candidate: MediaRecognitionCandidate): boolean {
	if (candidate.type !== type || !candidate.title.trim()) return false;

	if (
		[candidate.year, candidate.season, candidate.episode, candidate.episodeEnd].some(
			(value) => value !== undefined && (!Number.isInteger(value) || value < 0),
		)
	) {
		return false;
	}

	return candidate.type !== "tv_show" || (candidate.season !== undefined && candidate.episode !== undefined);
}
