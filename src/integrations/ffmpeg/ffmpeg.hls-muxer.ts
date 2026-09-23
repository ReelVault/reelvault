import type { PlaybackDecision, TranscodeConfig } from "@sdk/common/stream.types";
import { serverConfig } from "@/server.config";

/**
 * `-map` args selecting the video stream and the (possibly remapped) audio stream.
 */
export function buildStreamMapArgs(decision: PlaybackDecision): string[] {
	const audioSelector = decision.audioStreamIndex === undefined ? "0:a:0" : `0:${decision.audioStreamIndex}`;

	return ["-map", "0:v:0", "-map", audioSelector, "-map", "-0:s"];
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
