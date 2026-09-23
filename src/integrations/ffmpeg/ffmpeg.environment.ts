import { serverConfig } from "@/server.config";
import { createBinaryAvailability } from "../binary-lookup.utils";

export const assertFFMpegAvailable = createBinaryAvailability(
	() => serverConfig.ffmpeg.path,
	"Install FFmpeg and make sure both commands are available in PATH.",
);
