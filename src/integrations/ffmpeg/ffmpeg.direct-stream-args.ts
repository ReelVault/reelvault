import type { PlaybackDecision, TranscodeConfig } from "@reelvault/sdk/common";
import { serverConfig } from "@/server.config";
import { systemResourcesService } from "@/system/system-resources.service";
import { buildHlsMuxerArgs, buildStreamMapArgs } from "./ffmpeg.hls-muxer";

const HEVC_CODECS = new Set(["hevc", "h265"]);

export function buildDirectStreamOutputArgs(
	decision: PlaybackDecision,
	config: TranscodeConfig,
	startNumber: number,
	segmentPattern: string,
): string[] {
	// Same adaptive fallback as the transcode path (bounds decoder threads).
	const threads = serverConfig.ffmpeg.threads > 0 ? serverConfig.ffmpeg.threads : systemResourcesService.getFfmpegThreads();
	const isHevc = decision.videoCodec && HEVC_CODECS.has(decision.videoCodec.toLowerCase());

	return [
		"-threads",
		String(threads),
		"-map_metadata",
		"-1",
		"-map_chapters",
		"-1",
		"-codec:v:0",
		"copy",
		...(isHevc ? ["-tag:v:0", "hvc1"] : []),
		"-codec:a:0",
		"copy",
		...buildStreamMapArgs(decision),
		...buildHlsMuxerArgs(config, startNumber, segmentPattern),
	];
}
