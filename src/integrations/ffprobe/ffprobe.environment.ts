import { serverConfig } from "@/config/server/server.config";
import { createBinaryAvailability } from "@/integrations/binary-lookup.utils";

export const assertFFProbeAvailable = createBinaryAvailability(
	() => serverConfig.ffprobe.path,
	"Install FFmpeg/FFprobe and make sure the command is available.",
);
