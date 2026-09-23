import { beforeEach, describe, expect, it } from "bun:test";
import type { PlaybackDecision, TranscodeConfig } from "@reelvault/sdk/common";
import { systemSettingsStore } from "@/config/system-settings.store";
import { buildDirectStreamOutputArgs } from "@/integrations/ffmpeg/ffmpeg.direct-stream-args";
import { buildAudioFilter, buildTranscodeAudioArgs, buildTranscodeVideoArgs } from "@/integrations/ffmpeg/ffmpeg.transcode-args";
import { getBufferedSeekStart, isPositionBuffered, parseHlsBuffer } from "@/modules/streaming/buffer/hls-buffer";

const NO_TONEMAP = { method: "none" as const, algorithm: "bt2390" };

const config: TranscodeConfig = {
	maxSessions: 1,
	inactivityTimeout: 30_000,
	cleanupInterval: 10_000,
	tempRootDir: "/tmp/reelvault-test-transcodes",
	hlsSegmentDuration: 6,
};

const decision: PlaybackDecision = {
	mode: "direct-stream",
	videoTranscode: false,
	audioTranscode: false,
	audioStreamIndex: 2,
	reason: "Compatible streams",
};

describe("HLS buffering", () => {
	beforeEach(() => {
		systemSettingsStore.clearRuntimeValues();
	});
	it("reports completed segments and preserves gaps between buffered ranges", () => {
		const analysis = parseHlsBuffer(
			["#EXTM3U", "#EXTINF:6.000,", "seg_0.m4s", "#EXTINF:6.000,", "seg_1.m4s", "#EXTINF:5.000,", "seg_3.m4s", "#EXT-X-ENDLIST"].join("\n"),
			6,
		);

		expect(analysis.complete).toBeTrue();
		expect(analysis.bufferedSeconds).toBe(17);
		expect(analysis.bufferedUntil).toBe(23);
		expect(analysis.ranges).toEqual([
			{ startTime: 0, endTime: 12, startSegment: 0, endSegment: 1, segmentCount: 2 },
			{ startTime: 18, endTime: 23, startSegment: 3, endSegment: 3, segmentCount: 1 },
		]);
		expect(isPositionBuffered(analysis, 10)).toBeTrue();
		expect(isPositionBuffered(analysis, 15)).toBeFalse();
		expect(getBufferedSeekStart(analysis, 10, 6)).toBe(6);
		expect(getBufferedSeekStart(analysis, 15, 6)).toBeNull();
	});

	it("does not apply the absolute seek twice in direct-stream output arguments", () => {
		const args = buildDirectStreamOutputArgs(decision, config, 1, "/tmp/seg_%d.m4s");

		expect(args).not.toContain("-ss");
		expect(args).toEqual(expect.arrayContaining(["-map_metadata", "-1", "-map_chapters", "-1", "-codec:v:0", "copy", "-codec:a:0"]));
		expect(args).toContain("make_zero");
		expect(args).not.toContain("vod");
		expect(args).toContain("independent_segments+temp_file+discont_start");
		expect(args).toEqual(expect.arrayContaining(["-hls_segment_options", "movflags=+frag_discont"]));
	});

	it("uses compatibility-focused H.264 settings and segment-aligned keyframes", () => {
		// Pin the software encoder: on machines with detected NVENC the hardware
		// path would otherwise change these expectations run-to-run.
		systemSettingsStore.setRuntimeValue("ffmpeg.hwaccel", "none");
		const args = buildTranscodeVideoArgs(
			{
				...decision,
				mode: "transcode",
				videoTranscode: true,
				videoBitrateKbps: 3616,
			},
			config,
			undefined,
			NO_TONEMAP,
		);

		expect(args).toEqual(
			expect.arrayContaining(["libx264", "veryfast", "-pix_fmt", "yuv420p", "-force_key_frames", "expr:gte(t,n_forced*6)"]),
		);
	});

	it("selects hardware encoders when hwaccel is configured", () => {
		try {
			systemSettingsStore.setRuntimeValue("ffmpeg.hwaccel", "nvenc");
			const nvencArgs = buildTranscodeVideoArgs({ ...decision, mode: "transcode", videoTranscode: true }, config, undefined, NO_TONEMAP);
			expect(nvencArgs).toContain("h264_nvenc");

			systemSettingsStore.setRuntimeValue("ffmpeg.hwaccel", "vaapi");
			const vaapiArgs = buildTranscodeVideoArgs({ ...decision, mode: "transcode", videoTranscode: true }, config, undefined, NO_TONEMAP);
			expect(vaapiArgs).toContain("h264_vaapi");

			systemSettingsStore.setRuntimeValue("ffmpeg.hwaccel", "qsv");
			const qsvArgs = buildTranscodeVideoArgs({ ...decision, mode: "transcode", videoTranscode: true }, config, undefined, NO_TONEMAP);
			expect(qsvArgs).toContain("h264_qsv");

			systemSettingsStore.setRuntimeValue("ffmpeg.hwaccel", "videotoolbox");
			const vtArgs = buildTranscodeVideoArgs({ ...decision, mode: "transcode", videoTranscode: true }, config, undefined, NO_TONEMAP);
			expect(vtArgs).toContain("h264_videotoolbox");
		} finally {
			systemSettingsStore.setRuntimeValue("ffmpeg.hwaccel", "none");
		}
	});

	it("normalizes transcoded audio timestamps after seeking", () => {
		const args = buildTranscodeAudioArgs({
			...decision,
			mode: "transcode",
			audioTranscode: true,
		});

		expect(args).toContain("aresample=async=1:first_pts=0");
	});

	it("builds consistent audio filter for resampling and sync", () => {
		const filter = buildAudioFilter();
		expect(filter).toBe("aresample=async=1:first_pts=0");
	});

	it("adds hvc1 tag in direct stream when video codec is hevc", () => {
		const hevcDecision: PlaybackDecision = {
			...decision,
			videoCodec: "hevc",
		};
		const args = buildDirectStreamOutputArgs(hevcDecision, config, 0, "/tmp/seg_%d.m4s");
		expect(args).toEqual(expect.arrayContaining(["-tag:v:0", "hvc1"]));
		expect(args).toEqual(expect.arrayContaining(["-threads", "0"]));
		expect(args).toEqual(expect.arrayContaining(["-map", "-0:s"]));
	});

	it("applies configured x264 preset, CRF, lookahead and downscale filter in software transcode", () => {
		systemSettingsStore.setRuntimeValue("ffmpeg.preset", "ultrafast");
		systemSettingsStore.setRuntimeValue("ffmpeg.crf", 28);
		// Pin the software encoder — see the compatibility test above.
		systemSettingsStore.setRuntimeValue("ffmpeg.hwaccel", "none");

		const args = buildTranscodeVideoArgs(
			{
				...decision,
				mode: "transcode",
				videoTranscode: true,
			},
			config,
			undefined,
			NO_TONEMAP,
		);

		expect(args).toContain("ultrafast");
		expect(args).toEqual(expect.arrayContaining(["-crf", "28"]));
		expect(args).toEqual(expect.arrayContaining(["-x264opts:0", "subme=0:me_range=16:rc_lookahead=10:me=hex:open_gop=0"]));
		expect(args).toEqual(expect.arrayContaining(["-vf"]));
	});
});
