import { ffProbeService } from "@/integrations/ffprobe/ffprobe.service";
import type { FFProbeResult } from "@/integrations/ffprobe/ffprobe.types";
import { throwIfAborted } from "@/utils/cancellation.utils";
import { createLogger } from "@/utils/logger.utils";
import { getFileName } from "@/utils/path.utils";

export const videoParser = {
	serviceName: "VideoParser",
	logger: createLogger("VideoParser"),

	async probe(filePath: string, signal?: AbortSignal): Promise<FFProbeResult | null> {
		throwIfAborted(signal);
		const fileName = getFileName(filePath);
		const startedAt = performance.now();
		videoParser.logger.debug("Probing file", { fileName });

		try {
			const data = await ffProbeService.create().showFormat().showStreams().includeChapters().execute(filePath, signal);

			videoParser.logger.debug("Probe completed", { fileName, durationMs: Math.round(performance.now() - startedAt) });

			return data;
		} catch (error) {
			// A null probe is a designed-for outcome (every caller degrades to
			// keeping/omitting technical data), so it is an expected anomaly.
			videoParser.logger.warn("Probe failed — returning no probe result", {
				fileName,
				durationMs: Math.round(performance.now() - startedAt),
				error,
			});

			return null;
		}
	},
};
