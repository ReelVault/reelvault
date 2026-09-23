import type { PlaybackDecision, TranscodeConfig } from "@reelvault/sdk/common";
import { serverConfig } from "@/server.config";
import { systemResourcesService } from "@/system/system-resources.service";
import { clamp } from "@/utils/math.utils";
import { getEffectiveHwaccel, type ToneMapConfig } from "./ffmpeg.capabilities";

export function buildTranscodeAudioArgs(decision: PlaybackDecision): string[] {
	if (!decision.audioTranscode) return ["-c:a", "copy"];

	return [
		"-c:a",
		"aac",
		"-af",
		buildAudioFilter(),
		"-b:a",
		"192k",
		...(decision.audioChannels ? ["-ac", `${decision.audioChannels}`] : []),
	];
}

export function buildAudioFilter(): string {
	return "aresample=async=1:first_pts=0";
}

/**
 * HDR→SDR conversion chain for this ffmpeg build, or `null` when tone-mapping
 * is disabled in settings or no usable filter exists (legacy behavior). The
 * chain ends on `format=yuv420p`, so hardware-upload branches can append their
 * `format=nv12,hwupload` tail directly.
 */
export function buildToneMapFilterChain(decision: PlaybackDecision, toneMap: ToneMapConfig): string | null {
	if (!decision.tonemap || toneMap.method === "none") return null;

	const algorithm = toneMap.algorithm;
	if (toneMap.method === "tonemapx") {
		// tonemapx reads the transfer/primaries from frame metadata itself and
		// emits the target SDR format in one filter.
		return `tonemapx=t=bt709:p=bt709:m=bt709:tonemap=${algorithm}:format=yuv420p`;
	}

	// zscale needs the incoming PQ/HLG signal declared explicitly before the
	// linear-light conversion, otherwise untagged BT.2020 input is misread.
	const transfer = decision.tonemapTransfer ?? "smpte2084";

	return `setparams=color_primaries=bt2020:color_trc=${transfer}:colorspace=bt2020nc,zscale=t=linear:npl=100,tonemap=${algorithm}:desat=0,zscale=p=bt709:t=bt709:m=bt709:r=tv,format=yuv420p`;
}

/**
 * Builds hardware-accelerated input flags for decoding.
 *
 * VAAPI and QSV require `-hwaccel_output_format` so that decoded frames stay in
 * GPU memory (zero-copy path). Without it FFmpeg copies every frame to system
 * RAM on decode and back to GPU on encode — negating the hardware advantage.
 *
 * VideoToolbox needs `-allow_sw 1` so FFmpeg can fall back to a software
 * decoder when the hardware VTB session limit is reached, instead of erroring.
 *
 * Tone-mapped sessions deliberately DROP `-hwaccel_output_format`: software
 * filters (tonemapx/zscale) cannot consume GPU-resident frames, so decoded
 * frames land in system RAM and the hardware stays in the encode step only.
 */
export function buildHwaccelInputArgs(
	decision: PlaybackDecision,
	hw: ReturnType<typeof getEffectiveHwaccel> | undefined,
	toneMap: ToneMapConfig,
): string[] {
	if (!decision.videoTranscode || decision.forceSoftware) return [];

	const effectiveHw = hw ?? getEffectiveHwaccel();
	// Only drop the zero-copy output format when an actual software tone-map filter
	// will run — otherwise frames needlessly round-trip through system RAM.
	const keepFramesInRam = Boolean(decision.tonemap && toneMap.method !== "none");

	if (effectiveHw.type === "nvenc") {
		// `-hwaccel_output_format cuda` keeps decoded frames in VRAM (zero-copy) —
		// without it every frame round-trips through system RAM before nvenc.
		if (keepFramesInRam) return ["-hwaccel", "cuda", ...(effectiveHw.device ? ["-hwaccel_device", effectiveHw.device] : [])];

		return ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda", ...(effectiveHw.device ? ["-hwaccel_device", effectiveHw.device] : [])];
	}

	if (effectiveHw.type === "vaapi") {
		// `-vaapi_device` is the correct flag for VAAPI device selection;
		// `-hwaccel_device` is for CUDA/QSV. Using the wrong flag silently
		// falls back to the default device (or errors on multi-GPU systems).
		if (keepFramesInRam) return ["-hwaccel", "vaapi", ...(effectiveHw.device ? ["-vaapi_device", effectiveHw.device] : [])];

		return ["-hwaccel", "vaapi", "-hwaccel_output_format", "vaapi", ...(effectiveHw.device ? ["-vaapi_device", effectiveHw.device] : [])];
	}

	if (effectiveHw.type === "qsv") {
		if (keepFramesInRam) return ["-hwaccel", "qsv", ...(effectiveHw.device ? ["-hwaccel_device", effectiveHw.device] : [])];

		return ["-hwaccel", "qsv", "-hwaccel_output_format", "qsv", ...(effectiveHw.device ? ["-hwaccel_device", effectiveHw.device] : [])];
	}

	if (effectiveHw.type === "videotoolbox") {
		// `-allow_sw 1` permits a software-decode fallback when the VTB session
		// limit is hit (e.g. multiple simultaneous streams on macOS).
		return ["-hwaccel", "videotoolbox", "-allow_sw", "1"];
	}

	return [];
}

/**
 * direct-stream       → copy video as-is (free)
 * transcode + ok      → copy
 * transcode + not ok  → re-encode via configured encoder (libx264 / hardware)
 *
 * GOP sizing: `-g` sets the maximum keyframe interval (in frames).
 * `-keyint_min 1` allows the encoder to insert extra keyframes at scene cuts,
 * improving seek accuracy without adding unnecessary forced keyframes.
 * The `force_key_frames` expression is the hard guarantee for HLS segment
 * boundaries — it fires at every `hlsSegmentDuration` seconds regardless of GOP.
 */
function buildHlsGopArgs(hlsSegmentDuration: number, sourceFps?: number | null): string[] {
	// framesPerHlsSegment assumes a 24 fps source. For higher frame rates size
	// the GOP from the real fps (clamped to 1-2.5 segments of frames) so 60 fps
	// sources don't keyframe 2.5× more often than the segment boundaries need.
	const assumedFps = serverConfig.stream.framesPerHlsSegment / hlsSegmentDuration;
	const fps = sourceFps && sourceFps > 0 ? sourceFps : assumedFps;
	const gop = Math.round(hlsSegmentDuration * clamp(fps, assumedFps, assumedFps * 2.5));

	return ["-g", `${gop}`, "-keyint_min", "1", "-force_key_frames", `expr:gte(t,n_forced*${hlsSegmentDuration})`];
}

export function buildTranscodeVideoArgs(
	decision: PlaybackDecision,
	config: TranscodeConfig,
	hw: ReturnType<typeof getEffectiveHwaccel> | undefined,
	toneMap: ToneMapConfig,
): string[] {
	if (!decision.videoTranscode) return ["-c:v", "copy"];

	const gopArgs = buildHlsGopArgs(config.hlsSegmentDuration, decision.sourceFps);
	// forceSoftware (one-shot fallback after an encoder failure) skips hardware
	// encoders entirely and falls through to libx264 below.
	const effectiveHw = decision.forceSoftware ? undefined : (hw ?? getEffectiveHwaccel());
	// HDR sessions prepend the tone-mapping chain to every encoder's filter
	// graph; null = tone-mapping off/unavailable → legacy args verbatim.
	const toneMapChain = buildToneMapFilterChain(decision, toneMap);
	const vfArgs = toneMapChain ? ["-vf", toneMapChain] : [];

	switch (effectiveHw?.type ?? "none") {
		case "nvenc":
			return buildNvencArgs(decision, vfArgs, gopArgs);
		case "vaapi":
			return buildVaapiArgs(decision, toneMapChain, gopArgs);
		case "qsv":
			return buildQsvArgs(decision, vfArgs, gopArgs);
		case "amf":
			return buildAmfArgs(decision, vfArgs, gopArgs);
		case "videotoolbox":
			return buildVideoToolboxArgs(decision, vfArgs, gopArgs);
		case "none":
			return buildSoftwareVideoArgs(decision, toneMapChain, gopArgs);
		default:
			return buildSoftwareVideoArgs(decision, toneMapChain, gopArgs);
	}
}

function buildNvencArgs(decision: PlaybackDecision, vfArgs: string[], gopArgs: string[]): string[] {
	const bitrateArgs = decision.videoBitrateKbps
		? [
				// VBR with hard ceiling: quality adapts inside the cap.
				"-rc:v",
				"vbr",
				"-b:v",
				`${decision.videoBitrateKbps}k`,
				"-maxrate",
				`${decision.videoBitrateKbps}k`,
				"-bufsize",
				`${decision.videoBitrateKbps * 2}k`,
			]
		: ["-cq:v", "23"];

	return [
		"-c:v",
		"h264_nvenc",
		"-preset",
		"p4",
		"-tune",
		"ll", // low-latency tuning — reduces encode delay for streaming
		...bitrateArgs,
		...vfArgs,
		"-pix_fmt",
		"yuv420p",
		...gopArgs,
	];
}

function buildVaapiArgs(decision: PlaybackDecision, toneMapChain: string | null, gopArgs: string[]): string[] {
	const bitrateArgs = decision.videoBitrateKbps
		? ["-b:v", `${decision.videoBitrateKbps}k`, "-maxrate", `${decision.videoBitrateKbps}k`]
		: ["-qp", "23"];

	return [
		"-c:v",
		"h264_vaapi",
		"-vf",
		toneMapChain ? `${toneMapChain},format=nv12,hwupload` : "format=nv12|vaapi,hwupload", // surface upload when input is in system RAM
		...bitrateArgs,
		...gopArgs,
	];
}

function buildQsvArgs(decision: PlaybackDecision, vfArgs: string[], gopArgs: string[]): string[] {
	const bitrateArgs = decision.videoBitrateKbps
		? ["-b:v", `${decision.videoBitrateKbps}k`, "-maxrate", `${decision.videoBitrateKbps}k`]
		: ["-global_quality", "23", "-look_ahead", "1"];

	return ["-c:v", "h264_qsv", "-preset", "medium", ...bitrateArgs, ...vfArgs, ...gopArgs];
}

function buildAmfArgs(decision: PlaybackDecision, vfArgs: string[], gopArgs: string[]): string[] {
	const bitrateArgs = decision.videoBitrateKbps
		? [
				"-rc:v",
				"vbr_peak",
				"-b:v",
				`${decision.videoBitrateKbps}k`,
				"-maxrate",
				`${decision.videoBitrateKbps}k`,
				"-bufsize",
				`${decision.videoBitrateKbps * 2}k`,
			]
		: ["-quality:v", "balanced"];

	return ["-c:v", "h264_amf", ...bitrateArgs, ...vfArgs, "-pix_fmt", "yuv420p", ...gopArgs];
}

function buildVideoToolboxArgs(decision: PlaybackDecision, vfArgs: string[], gopArgs: string[]): string[] {
	const bitrateArgs = decision.videoBitrateKbps
		? ["-b:v", `${decision.videoBitrateKbps}k`, "-maxrate:v", `${decision.videoBitrateKbps}k`]
		: ["-q:v", "65"];

	return [
		"-c:v",
		"h264_videotoolbox",
		"-realtime",
		"1", // prefer lower latency over throughput on Apple Silicon
		...bitrateArgs,
		...vfArgs,
		"-pix_fmt",
		"yuv420p",
		...gopArgs,
	];
}

// Software fallback — libx264. "auto" preset/resolution scales with the
// measured core speed: Pi-class hardware cannot sustain veryfast 1080p, so
// it degrades preset + output resolution instead of stalling the client.
function buildSoftwareVideoArgs(decision: PlaybackDecision, toneMapChain: string | null, gopArgs: string[]): string[] {
	const speedFactor = systemResourcesService.getSpeedFactor();
	const preset = resolveSoftwarePreset(serverConfig.ffmpeg.preset, speedFactor);
	const { width: resolutionCap, height: resolutionHeightCap } = resolutionCaps(speedFactor);
	const lookahead = speedFactor >= 0.5 ? 10 : 5;
	const crf = serverConfig.ffmpeg.crf.toString();

	const bitrateArgs = decision.videoBitrateKbps
		? [
				"-b:v",
				`${decision.videoBitrateKbps}k`,
				"-maxrate",
				`${decision.videoBitrateKbps}k`,
				"-bufsize",
				`${decision.videoBitrateKbps * 2}k`,
			]
		: ["-crf", crf];

	return [
		"-c:v",
		"libx264",
		"-preset",
		preset,
		...bitrateArgs,
		"-sc_threshold",
		"0", // disable scene-detection keyframes — force_key_frames is the sole boundary source
		"-profile:v",
		"high",
		"-level",
		"4.1",
		"-x264opts:0",
		`subme=0:me_range=16:rc_lookahead=${lookahead}:me=hex:open_gop=0`,
		"-vf",
		`${toneMapChain ? `${toneMapChain},` : ""}setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709,scale=trunc(min(max(iw\\,ih*a)\\,min(${resolutionCap}\\,${resolutionHeightCap}*a))/2)*2:trunc(min(max(iw/a\\,ih)\\,min(${resolutionCap}/${resolutionHeightCap}\\,${resolutionHeightCap}))/2)*2,format=yuv420p`,
		"-pix_fmt",
		"yuv420p",
		...gopArgs,
	];
}

/** Picks the libx264 preset: an explicit setting wins unless it is "auto", which scales with CPU speed. */
function resolveSoftwarePreset(presetSetting: string | undefined, speedFactor: number): string {
	if (presetSetting && presetSetting !== "auto") return presetSetting;

	if (speedFactor >= 1) return "veryfast";

	if (speedFactor >= 0.35) return "superfast";

	return "ultrafast";
}

/** Output resolution caps for the software encoder, degraded on slow hardware. */
function resolutionCaps(speedFactor: number): { width: number; height: number } {
	if (speedFactor >= 1) return { width: 1920, height: 1080 };

	if (speedFactor >= 0.35) return { width: 1280, height: 720 };

	return { width: 854, height: 480 };
}
