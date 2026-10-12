import { ffProbeService } from "@/integrations/ffprobe/ffprobe.service";
import type { FFProbeResult } from "@/integrations/ffprobe/ffprobe.types";
import { systemResourcesService } from "@/system/system-resources.service";
import { createLogger } from "@/utils/logger";
import { PathUtils } from "@/utils/path.utils";
import { PromiseUtils } from "@/utils/promise.utils";
import { throwIfAborted } from "@/workers/utils/worker-cancellation";

class VideoParser {
	readonly serviceName = "VideoParser";
	readonly logger = createLogger("VideoParser");

	private readonly semaphore = PromiseUtils.createSemaphore(() => systemResourcesService.getFfprobeConcurrency());

	async probe(filePath: string, signal?: AbortSignal): Promise<FFProbeResult | null> {
		throwIfAborted(signal);
		await this.semaphore.acquire(signal);
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
		} finally {
			this.semaphore.release();
		}
	}
}

export const videoParser = new VideoParser();
