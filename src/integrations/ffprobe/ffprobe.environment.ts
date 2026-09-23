import { serverConfig } from "@/server.config";
import { createBinaryAvailability } from "../binary-lookup.utils";

export const assertFFProbeAvailable = createBinaryAvailability(
	() => serverConfig.ffprobe.path,
	"Install FFmpeg/FFprobe and make sure the command is available.",
);
