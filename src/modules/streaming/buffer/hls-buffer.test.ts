import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { PlaybackDecision, TranscodeConfig } from "@reelvault/sdk/common";
import { systemResourcesService } from "@/config/system-resources.service";
import { systemSettingsStore } from "@/config/system-settings.store";
import { buildDirectStreamOutputArgs } from "@/integrations/ffmpeg/ffmpeg.direct-stream-args";
import { buildTranscodeAudioArgs, buildTranscodeVideoArgs } from "@/integrations/ffmpeg/ffmpeg.transcode-args";
import { getBufferedSeekStart, isPositionBuffered, parseHlsBuffer } from "@/modules/streaming/buffer/hls-buffer.utils";
import { stubMethod } from "../../../../tests/helpers/method-stub.helper";

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

const activeStubs: Array<{ restore(): void }> = [];

beforeEach(() => {
	systemSettingsStore.clearRuntimeValues();
	// Pin the measured CPU speed: slow CI runners score below the 0.5
	// threshold, which flips the software lookahead from 10 to 5 and makes
	// the argument assertions machine-dependent.
	activeStubs.push(stubMethod(systemResourcesService, "getSpeedFactor", () => 1));
});

afterEach(() => {
	for (const stub of activeStubs.splice(0)) stub.restore();
	systemSettingsStore.clearRuntimeValues();
});

describe("HLS buffering", () => {
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
});

describe("HLS buffering encoder selection", () => {
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

	it.each([
		["nvenc", "h264_nvenc"],
		["vaapi", "h264_vaapi"],
		["qsv", "h264_qsv"],
		["videotoolbox", "h264_videotoolbox"],
	] as const)("selects the %s hardware H.264 encoder when hwaccel is configured", (hwaccel, encoder) => {
		systemSettingsStore.setRuntimeValue("ffmpeg.hwaccel", hwaccel);
		const args = buildTranscodeVideoArgs({ ...decision, mode: "transcode", videoTranscode: true }, config, undefined, NO_TONEMAP);

		expect(args).toContain(encoder);
	});
});

describe("HLS buffering stream output", () => {
	it("normalizes transcoded audio timestamps after seeking", () => {
		const args = buildTranscodeAudioArgs({
			...decision,
			mode: "transcode",
			audioTranscode: true,
		});

		expect(args).toContain("aresample=async=1:first_pts=0");
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

	it("applies the configured x264 preset and CRF in software transcode", () => {
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
