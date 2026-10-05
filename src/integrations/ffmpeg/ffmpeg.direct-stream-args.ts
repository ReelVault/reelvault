import type { PlaybackDecision, TranscodeConfig } from "@reelvault/sdk/common";
import { serverConfig } from "@/server.config";
import { buildHlsMuxerArgs, buildMetadataStripArgs, buildStreamMapArgs } from "./ffmpeg.hls-muxer";
import { resolveStreamingThreads } from "./ffmpeg.threads";

const HEVC_CODECS = new Set(["hevc", "h265"]);

export function buildDirectStreamOutputArgs(
	decision: PlaybackDecision,
	config: TranscodeConfig,
	startNumber: number,
	segmentPattern: string,
): string[] {
	// 0 active transcodes = full thread budget; remuxing is I/O-bound (see resolveStreamingThreads).
	const threads = resolveStreamingThreads(serverConfig.ffmpeg.threads, 0);
	const isHevc = decision.videoCodec && HEVC_CODECS.has(decision.videoCodec.toLowerCase());

	return [
		"-threads",
		String(threads),
		...buildMetadataStripArgs(),
		"-codec:v:0",
		"copy",
		...(isHevc ? ["-tag:v:0", "hvc1"] : []),
		"-codec:a:0",
		"copy",
		...buildStreamMapArgs(decision),
		...buildHlsMuxerArgs(config, startNumber, segmentPattern),
	];
}
