import type { AdminProcessesResponse } from "@reelvault/sdk/common";
import { ffmpegProcessTracker } from "@/integrations/ffmpeg/ffmpeg.process-tracker";
import { createLogger } from "@/utils/logger";

class AdminProcessesService {
	readonly serviceName = "AdminProcessesService";
	readonly logger = createLogger("AdminProcessesService");

	/** Point-in-time snapshot of every live child process (ffmpeg/ffprobe). */
	getProcesses(): AdminProcessesResponse {
		return {
			counts: ffmpegProcessTracker.counts(),
			processes: ffmpegProcessTracker.listProcesses().map((snapshot) => ({
				pid: snapshot.pid,
				purpose: snapshot.purpose,
				label: snapshot.label,
				startedAt: snapshot.startedAt.toISOString(),
				runtimeMs: snapshot.runtimeMs,
			})),
		};
	}
}

export const adminProcessesService = new AdminProcessesService();
