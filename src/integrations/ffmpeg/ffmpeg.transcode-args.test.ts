import { describe, expect, test } from "bun:test";
import type { PlaybackDecision, TranscodeConfig } from "@reelvault/sdk/common";
import type { DetectedHwaccel, ToneMapConfig } from "./ffmpeg.capabilities";
import { buildHwaccelInputArgs, buildToneMapFilterChain, buildTranscodeVideoArgs } from "./ffmpeg.transcode-args";

const VAAPI_TONEMAP_UPLOAD_PATTERN = /^tonemapx=.*,format=nv12,hwupload$/;

const config: TranscodeConfig = {
	maxSessions: 5,
	inactivityTimeout: 90_000,
	cleanupInterval: 60_000,
	tempRootDir: "/tmp/reelvault-test",
	hlsSegmentDuration: 6,
};

const hw = (type: DetectedHwaccel["type"]): DetectedHwaccel => ({
	type,
	device: "/dev/dri/renderD128",
	h264Encoder: "h264",
	hevcEncoder: "hevc",
});

const toneMap = (method: ToneMapConfig["method"]): ToneMapConfig => ({ method, algorithm: "bt2390" });

const sdrDecision: PlaybackDecision = {
	mode: "transcode",
	videoTranscode: true,
	audioTranscode: false,
	videoCodec: "h264",
	reason: "test",
};

const hdrDecision: PlaybackDecision = {
	mode: "transcode",
	videoTranscode: true,
	audioTranscode: false,
	videoCodec: "h265",
	tonemap: true,
	tonemapTransfer: "smpte2084",
	reason: "video:h265 HDR10 → H.264, tone-mapped to SDR; test",
};

describe("buildToneMapFilterChain", () => {
	test("returns null for non-HDR decisions", () => {
		expect(buildToneMapFilterChain(sdrDecision, toneMap("tonemapx"))).toBeNull();
	});

	test("uses tonemapx when available", () => {
		const chain = buildToneMapFilterChain(hdrDecision, toneMap("tonemapx"));
		expect(chain).toContain("tonemapx=t=bt709:p=bt709:m=bt709:tonemap=bt2390:format=yuv420p");
	});

	test("zscale chain declares the incoming PQ transfer before conversion", () => {
		const chain = buildToneMapFilterChain(hdrDecision, toneMap("zscale"));
		expect(chain).toContain("setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc");
		expect(chain).toContain("zscale=t=linear:npl=100,tonemap=bt2390");
		expect(chain?.endsWith("format=yuv420p")).toBe(true);
	});

	test("returns null when no usable filter exists", () => {
		expect(buildToneMapFilterChain(hdrDecision, toneMap("none"))).toBeNull();
	});
});

describe("buildHwaccelInputArgs", () => {
	test("drops -hwaccel_output_format for tone-mapped sessions (filters need frames in RAM)", () => {
		const withTonemap = buildHwaccelInputArgs(hdrDecision, hw("nvenc"), toneMap("tonemapx"));
		const withoutTonemap = buildHwaccelInputArgs(sdrDecision, hw("nvenc"), toneMap("tonemapx"));

		expect(withTonemap).not.toContain("-hwaccel_output_format");
		expect(withTonemap).toContain("-hwaccel");
		expect(withoutTonemap).toContain("-hwaccel_output_format");
	});

	test("keeps the zero-copy path when HDR but no tone-map filter is available", () => {
		const args = buildHwaccelInputArgs(hdrDecision, hw("nvenc"), toneMap("none"));
		expect(args).toContain("-hwaccel_output_format");
	});

	test("keeps zero-copy path for SDR VAAPI sessions", () => {
		const args = buildHwaccelInputArgs(sdrDecision, hw("vaapi"), toneMap("tonemapx"));
		expect(args).toContain("-hwaccel_output_format");
		expect(args).toContain("-vaapi_device");
	});
});

describe("buildTranscodeVideoArgs", () => {
	test("SDR nvenc args carry no -vf (unchanged baseline)", () => {
		const args = buildTranscodeVideoArgs(sdrDecision, config, hw("nvenc"), toneMap("tonemapx"));
		expect(args).not.toContain("-vf");
	});

	test("HDR nvenc args prepend the tone-map chain", () => {
		const args = buildTranscodeVideoArgs(hdrDecision, config, hw("nvenc"), toneMap("tonemapx"));
		const vfIndex = args.indexOf("-vf");
		expect(vfIndex).toBeGreaterThan(-1);
		expect(args[vfIndex + 1]).toContain("tonemapx");
	});

	test("HDR vaapi args append hwupload after the tone-map chain", () => {
		const args = buildTranscodeVideoArgs(hdrDecision, config, hw("vaapi"), toneMap("tonemapx"));
		const vfIndex = args.indexOf("-vf");
		expect(args[vfIndex + 1]).toMatch(VAAPI_TONEMAP_UPLOAD_PATTERN);
	});

	test("HDR libx264 args prepend the chain before the BT.709 tagging", () => {
		const args = buildTranscodeVideoArgs(hdrDecision, config, hw("none"), toneMap("zscale"));
		const vfIndex = args.indexOf("-vf");
		expect(args[vfIndex + 1]).toContain("zscale=t=linear:npl=100");
		expect(args[vfIndex + 1]).toContain("setparams=color_primaries=bt709");
		expect(args[vfIndex + 1]).toContain("format=yuv420p");
	});

	test("libx264 SDR args are byte-identical with tone-mapping unavailable", () => {
		const args = buildTranscodeVideoArgs(sdrDecision, config, hw("none"), toneMap("none"));
		const vfIndex = args.indexOf("-vf");
		expect(args[vfIndex + 1]).toStartWith("setparams=color_primaries=bt709");
		expect(args).not.toContain("tonemapx");
	});
});
