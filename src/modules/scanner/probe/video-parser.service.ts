import { ffProbeService } from "@/integrations/ffprobe/ffprobe.service";
import type { FFProbeResult } from "@/integrations/ffprobe/ffprobe.types";
import { throwIfAborted } from "@/utils/cancellation.utils";
import { createLogger } from "@/utils/logger.utils";
import { PathUtils } from "@/utils/path.utils";

class VideoParser {
	readonly serviceName = "VideoParser";
	readonly logger = createLogger("VideoParser");

	async probe(filePath: string, signal?: AbortSignal): Promise<FFProbeResult | null> {
		throwIfAborted(signal);
		const fileName = PathUtils.getFileName(filePath);
		const startedAt = performance.now();
		this.logger.debug("Probing file", { fileName });

		try {
			const data = await ffProbeService.create().showFormat().showStreams().includeChapters().execute(filePath, signal);

			this.logger.debug("Probe completed", { fileName, durationMs: Math.round(performance.now() - startedAt) });

			return data;
		} catch (error) {
			// A null probe is a designed-for outcome (every caller degrades to
			// keeping/omitting technical data), so it is an expected anomaly.
			this.logger.warn("Probe failed — returning no probe result", {
				fileName,
				durationMs: Math.round(performance.now() - startedAt),
				error,
			});

			return null;
		}
	}
}

export const videoParser = new VideoParser();
