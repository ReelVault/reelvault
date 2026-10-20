import { FFProbeBuilder } from "./ffprobe.builder";
import { assertFFProbeAvailable } from "./ffprobe.environment";

export const ffProbeService = {
	create() {
		assertFFProbeAvailable();

		return new FFProbeBuilder();
	},
};
