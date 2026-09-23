import { which } from "bun";
import { serverConfig } from "@/server.config";
import { FFProbeBuilder } from "./ffprobe.builder";
import { assertFFProbeAvailable } from "./ffprobe.environment";

class FFProbeService {
	isAvailable(): boolean {
		return Boolean(which(serverConfig.ffprobe.path));
	}

	create() {
		assertFFProbeAvailable();

		return new FFProbeBuilder();
	}
}

export const ffProbeService = new FFProbeService();
