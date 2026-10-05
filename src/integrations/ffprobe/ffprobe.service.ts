import { FFProbeBuilder } from "./ffprobe.builder";
import { assertFFProbeAvailable } from "./ffprobe.environment";

class FFProbeService {
	create() {
		assertFFProbeAvailable();

		return new FFProbeBuilder();
	}
}

export const ffProbeService = new FFProbeService();
