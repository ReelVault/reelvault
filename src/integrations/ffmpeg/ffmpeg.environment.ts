import { serverConfig } from "@/config/server/server.config";
import { createBinaryAvailability } from "@/integrations/binary-lookup.utils";

export const assertFFMpegAvailable = createBinaryAvailability(
	() => serverConfig.ffmpeg.path,
	"Install FFmpeg and make sure both commands are available in PATH.",
);
