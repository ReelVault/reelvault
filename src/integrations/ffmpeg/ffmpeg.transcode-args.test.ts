import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlaybackDecision, TranscodeConfig } from "@reelvault/sdk/common";
import { systemResourcesService } from "@/config/system-resources.service";
import { systemSettingsStore } from "@/config/system-settings.store";
import type { DetectedHwaccel } from "./capabilities/hwaccel.utils";
import type { ToneMapConfig } from "./capabilities/tone-mapping.resolver";
import { buildHwaccelInputArgs, buildToneMapFilterChain, buildTranscodeAudioArgs, buildTranscodeVideoArgs } from "./ffmpeg.transcode-args";

const RENDER_NODE = "/dev/dri/renderD128";
const TONEMAPX_CHAIN = "tonemapx=t=bt709:p=bt709:m=bt709:tonemap=bt2390:format=yuv420p";
const ZSCALE_CHAIN =
	"setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc,zscale=t=linear:npl=100,tonemap=bt2390:desat=0,zscale=p=bt709:t=bt709:m=bt709:r=tv,format=yuv420p";

const config: TranscodeConfig = {
	maxSessions: 5,
	inactivityTimeout: 90_000,
	cleanupInterval: 60_000,
	tempRootDir: "/tmp/reelvault-test",
	hlsSegmentDuration: 6,
};

const hw = (type: DetectedHwaccel["type"]): DetectedHwaccel => ({
	type,
	device: RENDER_NODE,
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

/** The value that follows a flag, or undefined when the flag is absent. */
function flagValue(args: string[], flag: string): string | undefined {
	const index = args.indexOf(flag);

	return index === -1 ? undefined : args[index + 1];
}

// The software encoder's preset, resolution cap and x264 lookahead all scale with
// the measured CPU speed. The factor is pinned to 1 for every test, and a test that
// needs another speed sets it here. A slow CI runner would otherwise see a different
// preset and cap, and the argument assertions would depend on the machine.
const speed = { factor: 1 };
const spies: Array<{ mockRestore(): void }> = [];

beforeEach(() => {
	spies.push(spyOn(systemResourcesService, "getSpeedFactor").mockImplementation(() => speed.factor));
});

afterEach(() => {
	speed.factor = 1;
	systemSettingsStore.clearRuntimeValues();
	for (const spy of spies.splice(0)) spy.mockRestore();
});

/** Runs a command and returns its stdout. A non-zero exit fails the test with the tool's stderr. */
async function runCommand(command: string[]): Promise<string> {
	const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	if (code !== 0) throw new Error(`${command[0]} exited with ${code}: ${stderr}`);

	return stdout;
}

/** Encodes one frame of a generated source through the video filter in `args`, and reads back the frame size. */
async function encodedFrameSize(sourceSize: string, args: string[]): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "reelvault-scale-"));
	try {
		const output = join(directory, "frame.png");
		await runCommand([
			"ffmpeg",
			"-v",
			"error",
			"-f",
			"lavfi",
			"-i",
			`testsrc=size=${sourceSize}:rate=1:duration=1`,
			"-frames:v",
			"1",
			"-vf",
			flagValue(args, "-vf") ?? "",
			output,
		]);

		return (
			await runCommand([
				"ffprobe",
				"-v",
				"error",
				"-select_streams",
				"v:0",
				"-show_entries",
				"stream=width,height",
				"-of",
				"csv=s=x:p=0",
				output,
			])
		).trim();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

describe("buildToneMapFilterChain", () => {
	test("returns null for non-HDR decisions", () => {
		expect(buildToneMapFilterChain(sdrDecision, toneMap("tonemapx"))).toBeNull();
	});

	test("uses tonemapx when available", () => {
		expect(buildToneMapFilterChain(hdrDecision, toneMap("tonemapx"))).toBe(TONEMAPX_CHAIN);
	});

	test("zscale chain declares the incoming PQ transfer before conversion", () => {
		expect(buildToneMapFilterChain(hdrDecision, toneMap("zscale"))).toBe(ZSCALE_CHAIN);
	});

	test("returns null when no usable filter exists", () => {
		expect(buildToneMapFilterChain(hdrDecision, toneMap("none"))).toBeNull();
	});
});

describe("buildHwaccelInputArgs", () => {
	test.each([
		["nvenc", ["-hwaccel", "cuda", "-hwaccel_device", RENDER_NODE]],
		["vaapi", ["-hwaccel", "vaapi", "-vaapi_device", RENDER_NODE]],
		["qsv", ["-hwaccel", "qsv", "-hwaccel_device", RENDER_NODE]],
	] as const)("decodes a tone-mapped %s session into system memory, where the software filter can read it", (type, expected) => {
		expect(buildHwaccelInputArgs(hdrDecision, hw(type), toneMap("tonemapx"))).toEqual([...expected]);
	});

	test.each([
		["nvenc", ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda", "-hwaccel_device", RENDER_NODE]],
		["vaapi", ["-hwaccel", "vaapi", "-hwaccel_output_format", "vaapi", "-vaapi_device", RENDER_NODE]],
		["qsv", ["-hwaccel", "qsv", "-hwaccel_output_format", "qsv", "-hwaccel_device", RENDER_NODE]],
	] as const)("keeps the decoded frames of an SDR %s session on the GPU", (type, expected) => {
		expect(buildHwaccelInputArgs(sdrDecision, hw(type), toneMap("tonemapx"))).toEqual([...expected]);
	});

	test("keeps the GPU path when HDR has no tone-map filter", () => {
		expect(buildHwaccelInputArgs(hdrDecision, hw("nvenc"), toneMap("none"))).toEqual([
			"-hwaccel",
			"cuda",
			"-hwaccel_output_format",
			"cuda",
			"-hwaccel_device",
			RENDER_NODE,
		]);
	});

	test("allows a software decode fallback on VideoToolbox when its session limit is hit", () => {
		expect(buildHwaccelInputArgs(sdrDecision, hw("videotoolbox"), toneMap("none"))).toEqual(["-hwaccel", "videotoolbox", "-allow_sw", "1"]);
	});

	test("adds no decode flags for the software encoder", () => {
		expect(buildHwaccelInputArgs(sdrDecision, hw("none"), toneMap("tonemapx"))).toEqual([]);
	});
});

describe("buildTranscodeVideoArgs", () => {
	test("SDR NVENC encodes with constant-quality VBR and a GOP tied to the HLS segments", () => {
		expect(buildTranscodeVideoArgs(sdrDecision, config, hw("nvenc"), toneMap("tonemapx"))).toEqual([
			"-c:v",
			"h264_nvenc",
			"-preset",
			"p4",
			"-tune",
			"ll",
			"-cq:v",
			"23",
			"-pix_fmt",
			"yuv420p",
			"-g",
			"144",
			"-keyint_min",
			"1",
			"-force_key_frames",
			"expr:gte(t,n_forced*6)",
		]);
	});

	test("HDR NVENC prepends the tone-map chain to the filter graph", () => {
		const args = buildTranscodeVideoArgs(hdrDecision, config, hw("nvenc"), toneMap("tonemapx"));

		expect(flagValue(args, "-vf")).toBe(TONEMAPX_CHAIN);
	});

	test("HDR VAAPI uploads the tone-mapped frames to a GPU surface", () => {
		const args = buildTranscodeVideoArgs(hdrDecision, config, hw("vaapi"), toneMap("tonemapx"));

		expect(flagValue(args, "-vf")).toBe(`${TONEMAPX_CHAIN},format=nv12,hwupload`);
	});

	test("HDR libx264 prepends the zscale chain before the BT.709 tagging", () => {
		const args = buildTranscodeVideoArgs(hdrDecision, config, hw("none"), toneMap("zscale"));

		expect(flagValue(args, "-vf")?.split(",scale=")[0]).toBe(
			`${ZSCALE_CHAIN},setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709`,
		);
	});

	test("SDR libx264 starts its filter chain with the BT.709 tagging and no tone-map", () => {
		const args = buildTranscodeVideoArgs(sdrDecision, config, hw("none"), toneMap("none"));

		expect(flagValue(args, "-vf")?.split(",scale=")[0]).toBe("setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709");
	});

	test.each([
		["3840x2160", 1, "1920x1080"],
		["3840x2160", 0.5, "1280x720"],
		["1080x1920", 1, "606x1080"],
	] as const)("a %s source at speed factor %s is scaled to %s", async (source, factor, expected) => {
		speed.factor = factor;
		const args = buildTranscodeVideoArgs(sdrDecision, config, hw("none"), toneMap("none"));

		expect(await encodedFrameSize(source, args)).toBe(expected);
	});
});

describe("buildTranscodeVideoArgs encoder and rate settings", () => {
	test("libx264 sizes the GOP from the source frame rate", () => {
		const gopOf = (sourceFps?: number) => {
			const args = buildTranscodeVideoArgs({ ...sdrDecision, sourceFps }, config, hw("none"), toneMap("none"));

			return flagValue(args, "-g");
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
		expect(flagValue(buildTranscodeVideoArgs(sdrDecision, config, hw(type), toneMap("none")), "-c:v")).toBe(encoder);
	});

	test("libx264 uses the High profile, 4:2:0 pixels and segment-aligned forced keyframes", () => {
		const args = buildTranscodeVideoArgs({ ...sdrDecision, videoBitrateKbps: 3616 }, config, hw("none"), toneMap("none"));

		expect(flagValue(args, "-c:v")).toBe("libx264");
		expect(flagValue(args, "-profile:v")).toBe("high");
		expect(flagValue(args, "-pix_fmt")).toBe("yuv420p");
		expect(flagValue(args, "-force_key_frames")).toBe("expr:gte(t,n_forced*6)");
	});

	test("applies the configured x264 preset and CRF in a software transcode", () => {
		systemSettingsStore.setRuntimeValue("ffmpeg.preset", "ultrafast");
		systemSettingsStore.setRuntimeValue("ffmpeg.crf", 28);

		const args = buildTranscodeVideoArgs(sdrDecision, config, hw("none"), toneMap("none"));

		expect(flagValue(args, "-preset")).toBe("ultrafast");
		expect(flagValue(args, "-crf")).toBe("28");
		expect(flagValue(args, "-x264opts:0")).toBe("subme=0:me_range=16:rc_lookahead=10:me=hex:open_gop=0");
	});

	test.each([
		["veryfast", 1],
		["superfast", 0.35],
		["ultrafast", 0.2],
	] as const)("the auto preset is %s on a host at speed factor %s", (preset, factor) => {
		systemSettingsStore.setRuntimeValue("ffmpeg.preset", "auto");
		speed.factor = factor;

		expect(flagValue(buildTranscodeVideoArgs(sdrDecision, config, hw("none"), toneMap("none")), "-preset")).toBe(preset);
	});

	test("an explicit preset ignores the measured speed", () => {
		systemSettingsStore.setRuntimeValue("ffmpeg.preset", "medium");
		speed.factor = 0.2;

		expect(flagValue(buildTranscodeVideoArgs(sdrDecision, config, hw("none"), toneMap("none")), "-preset")).toBe("medium");
	});
});

describe("transcoded audio arguments", () => {
	const audioDecision: PlaybackDecision = { ...sdrDecision, audioTranscode: true, audioChannels: 6 };

	test("normalizes the transcoded audio timestamps after a seek", () => {
		const args = buildTranscodeAudioArgs({ ...sdrDecision, audioTranscode: true });

		expect(flagValue(args, "-af")).toBe("aresample=async=1:first_pts=0");
	});

	test("uses the configured audio bitrate and keeps the source channel count by default", () => {
		systemSettingsStore.setRuntimeValue("ffmpeg.audioBitrateKbps", 256);

		const args = buildTranscodeAudioArgs(audioDecision);

		expect(flagValue(args, "-b:a")).toBe("256k");
		expect(args.slice(args.indexOf("-ac"))).toEqual(["-ac", "6"]);
	});

	test("downmixes to stereo when the setting is on", () => {
		systemSettingsStore.setRuntimeValue("ffmpeg.downmixToStereo", true);

		const args = buildTranscodeAudioArgs(audioDecision);

		expect(args.slice(args.indexOf("-ac"))).toEqual(["-ac", "2"]);
	});
});
