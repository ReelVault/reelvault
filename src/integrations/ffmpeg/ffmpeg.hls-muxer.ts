import type { PlaybackDecision, TranscodeConfig } from "@reelvault/sdk/common";
import { serverConfig } from "@/server.config";
import { PathUtils } from "@/utils/path.utils";

/**
 * `-map` args selecting the video stream and the (possibly remapped) audio stream.
 */
export function buildStreamMapArgs(decision: PlaybackDecision): string[] {
	const audioSelector = decision.audioStreamIndex === undefined ? "0:a:0" : `0:${decision.audioStreamIndex}`;

	return ["-map", "0:v:0", "-map", audioSelector, "-map", "-0:s"];
}

/**
 * Builds an HLS output path with forward slashes. FFmpeg's HLS muxer derives
 * the fMP4 init segment's directory from the playlist path with
 * `strrchr(path, '/')` (libavformat/hlsenc.c, `base_output_dirname`); a native
 * Windows path contains none, so `init.mp4` landed in FFmpeg's working
 * directory instead of the session directory (trac #6541 behavior, still
 * present for `\` in current releases). Forward slashes are valid output paths
 * on every platform.
 */
export function buildHlsOutputPath(outputDir: string, fileName: string): string {
	return PathUtils.normalize(PathUtils.join(outputDir, fileName));
}

/**
 * fMP4 HLS muxer args shared by every streaming strategy. `startNumber > 0`
 * signals a seek restart, which requires `discont_start` so hls.js treats the
 * new segment range as a discontinuity rather than a continuation.
 */
export function buildHlsMuxerArgs(config: TranscodeConfig, startNumber: number, segmentPattern: string): string[] {
	return [
		"-max_muxing_queue_size",
		`${serverConfig.stream.hlsMaxMuxingQueueSize}`,
		"-avoid_negative_ts",
		"make_zero",
		"-f",
		"hls",
		"-max_delay",
		"5000000",
		"-hls_segment_type",
		"fmp4",
		"-hls_fmp4_init_filename",
		"init.mp4",
		"-hls_playlist_type",
		"event",
		"-hls_time",
		`${config.hlsSegmentDuration}`,
		"-hls_list_size",
		"0",
		"-hls_base_url",
		"segments/",
		"-hls_flags",
		startNumber > 0 ? "independent_segments+temp_file+discont_start" : "independent_segments+temp_file",
		...(startNumber > 0 ? ["-hls_segment_options", "movflags=+frag_discont"] : []),
		"-start_number",
		`${startNumber}`,
		"-hls_segment_filename",
		segmentPattern,
	];
}

export function segmentStartNumber(startTime: number, config: TranscodeConfig): number {
	return Math.floor(startTime / config.hlsSegmentDuration);
}
