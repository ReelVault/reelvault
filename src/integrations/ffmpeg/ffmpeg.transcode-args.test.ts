import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { PlaybackDecision, TranscodeConfig } from "@reelvault/sdk/common";
import { systemResourcesService } from "@/config/system-resources.service";
import { systemSettingsStore } from "@/config/system-settings.store";
import { type DetectedHwaccel, hardwareDecodeArgs } from "./capabilities/hwaccel.utils";
import type { ToneMapConfig } from "./capabilities/tone-mapping.resolver";
import { buildHwaccelInputArgs, buildToneMapFilterChain, buildTranscodeAudioArgs, buildTranscodeVideoArgs } from "./ffmpeg.transcode-args";

const VAAPI_TONEMAP_UPLOAD_PATTERN = /^tonemapx=.*,format=nv12,hwupload$/;
const LIBX264_HEIGHT_CAP_PATTERN = /trunc\(min\(max\(iw\/a\\,ih\)\\,min\(\d+\/a\\,\d+\)\)/;

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

const spies: Array<{ mockRestore(): void }> = [];

// The software encoder's preset, resolution cap and x264 lookahead all scale
// with the measured CPU speed, so the factor is pinned here. A slow CI runner
// would otherwise see a different preset, a smaller cap and a shorter
// lookahead, and the argument assertions would depend on the machine.
beforeEach(() => {
	spies.push(spyOn(systemResourcesService, "getSpeedFactor").mockReturnValue(1));
});

afterEach(() => {
	for (const spy of spies.splice(0)) spy.mockRestore();
});

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

	test("decode-only args are byte-identical to hardwareDecodeArgs for tone-mapped sessions", () => {
		for (const type of ["nvenc", "vaapi", "qsv"] as const) {
			const candidate = hw(type);

			expect(buildHwaccelInputArgs(hdrDecision, candidate, toneMap("tonemapx"))).toEqual(hardwareDecodeArgs(candidate));
		}
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

	test("libx264 caps the height against the source aspect ratio", () => {
		const args = buildTranscodeVideoArgs(sdrDecision, config, hw("none"), toneMap("none"));
		const vf = args[args.indexOf("-vf") + 1] ?? "";

		// The height branch must be min(widthCap / a, heightCap). Dividing by the
		// height cap instead collapses to a constant and disables the cap entirely.
		expect(vf).toMatch(LIBX264_HEIGHT_CAP_PATTERN);
	});

	test("libx264 sizes the GOP from the source frame rate", () => {
		const gopOf = (sourceFps?: number) => {
			const args = buildTranscodeVideoArgs({ ...sdrDecision, sourceFps }, config, hw("none"), toneMap("none"));

			return args[args.indexOf("-g") + 1];
		};

		expect(gopOf()).toBe("144"); // no fps → 24 fps assumed → one 6 s segment
		expect(gopOf(24)).toBe("144");
		expect(gopOf(60)).toBe("360"); // clamped to 2.5 segments
	});

	// The accelerator is passed in, so the encoder does not depend on what the
	// host's ffmpeg build happens to support.
	test.each([
		["nvenc", "h264_nvenc"],
		["vaapi", "h264_vaapi"],
		["qsv", "h264_qsv"],
		["videotoolbox", "h264_videotoolbox"],
	] as const)("selects the %s hardware H.264 encoder", (type, encoder) => {
		const args = buildTranscodeVideoArgs(sdrDecision, config, hw(type), toneMap("none"));

		expect(args).toContain(encoder);
	});

	test("uses compatibility-focused H.264 settings and segment-aligned keyframes", () => {
		const args = buildTranscodeVideoArgs({ ...sdrDecision, videoBitrateKbps: 3616 }, config, hw("none"), toneMap("none"));

		expect(args).toEqual(
			expect.arrayContaining(["libx264", "veryfast", "-pix_fmt", "yuv420p", "-force_key_frames", "expr:gte(t,n_forced*6)"]),
		);
	});

	test("applies the configured x264 preset and CRF in a software transcode", () => {
		systemSettingsStore.setRuntimeValue("ffmpeg.preset", "ultrafast");
		systemSettingsStore.setRuntimeValue("ffmpeg.crf", 28);

		const args = buildTranscodeVideoArgs(sdrDecision, config, hw("none"), toneMap("none"));

		expect(args).toContain("ultrafast");
		expect(args).toEqual(expect.arrayContaining(["-crf", "28"]));
		expect(args).toEqual(expect.arrayContaining(["-x264opts:0", "subme=0:me_range=16:rc_lookahead=10:me=hex:open_gop=0"]));
	});
});

describe("transcoded audio arguments", () => {
	const audioDecision: PlaybackDecision = { ...sdrDecision, audioTranscode: true, audioChannels: 6 };

	afterEach(() => {
		systemSettingsStore.clearRuntimeValues();
	});

	test("normalizes the transcoded audio timestamps after a seek", () => {
		const args = buildTranscodeAudioArgs({ ...sdrDecision, audioTranscode: true });

		expect(args).toContain("aresample=async=1:first_pts=0");
	});

	test("uses the configured audio bitrate and keeps the source channel count by default", () => {
		systemSettingsStore.setRuntimeValue("ffmpeg.audioBitrateKbps", 256);

		const args = buildTranscodeAudioArgs(audioDecision);

		expect(args).toContain("256k");
		expect(args.slice(args.indexOf("-ac"))).toEqual(["-ac", "6"]);
	});

	test("downmixes to stereo when the setting is on", () => {
		systemSettingsStore.setRuntimeValue("ffmpeg.downmixToStereo", true);

		const args = buildTranscodeAudioArgs(audioDecision);

		expect(args.slice(args.indexOf("-ac"))).toEqual(["-ac", "2"]);
	});
});
