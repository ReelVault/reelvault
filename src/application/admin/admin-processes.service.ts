import type { AdminProcessesResponse } from "@sdk/common";
import { ffmpegProcessTracker } from "@/integrations/ffmpeg/ffmpeg.process-tracker";
import { BaseService } from "@/utils/base-service";

class AdminProcessesService extends BaseService {
	constructor() {
		super("AdminProcessesService");
	}

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
