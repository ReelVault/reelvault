import type { FfmpegHwaccelOption } from "@/config/definitions/streaming.definitions";
import { serverConfig } from "@/config/server/server.config";
import { getDetectedDriDevice } from "./probe.utils";

type HwaccelType = Exclude<FfmpegHwaccelOption, "auto">;

export interface DetectedHwaccel {
	type: HwaccelType;
	device: string | null;
	h264Encoder: string;
	hevcEncoder: string;
}

/** Software-only accelerator descriptor — the fallback whenever no HW encoder is usable. */
export const SOFTWARE_HWACCEL: DetectedHwaccel = { type: "none", device: null, h264Encoder: "libx264", hevcEncoder: "libx265" };

/** `[flag, device]` when a device is set, otherwise no arguments. */
export function withDevice(flag: string, device: string | null): string[] {
	return device ? [flag, device] : [];
}

/**
 * Input-side hardware decode flags for the accelerator family. Frames land back
 * in system RAM (no `-hwaccel_output_format`), so software filters keep working
 * after the decode.
 */
export function hardwareDecodeArgs(hw: DetectedHwaccel): string[] {
	switch (hw.type) {
		case "nvenc":
			return ["-hwaccel", "cuda", ...withDevice("-hwaccel_device", hw.device)];
		case "qsv":
			return ["-hwaccel", "qsv", ...withDevice("-hwaccel_device", hw.device)];
		case "vaapi":
			return ["-hwaccel", "vaapi", ...withDevice("-vaapi_device", hw.device)];
		case "videotoolbox":
			return ["-hwaccel", "videotoolbox"];
		case "amf":
			return ["-hwaccel", "d3d11va"];
		case "none":
			return [];
		default:
			return [];
	}
}

/** Accelerators this host could use, in preference order. Encoders and hwaccels come from the FFmpeg probe. */
export function getCandidateHwaccels(encoders: ReadonlySet<string>, hwaccels: ReadonlySet<string>): DetectedHwaccel[] {
	const configHw = serverConfig.ffmpeg.hwaccel;
	const configDevice = serverConfig.ffmpeg.hwaccelDevice.trim() || null;

	const hasEncoder = (name: string) => encoders.size === 0 || encoders.has(name);
	const buildResult = (type: HwaccelType, device: string | null, h264: string, hevc: string): DetectedHwaccel => ({
		type,
		device,
		h264Encoder: hasEncoder(h264) ? h264 : "libx264",
		hevcEncoder: hasEncoder(hevc) ? hevc : "libx265",
	});

	const configured = configuredHwaccel(configHw, configDevice, buildResult);
	if (configured) return configured;

	return detectedHwaccels(encoders, hwaccels, configDevice, buildResult);
}

/** The accelerator the configuration pins, when it pins one. */
function configuredHwaccel(
	configHw: string,
	configDevice: string | null,
	buildResult: (type: HwaccelType, device: string | null, h264: string, hevc: string) => DetectedHwaccel,
): DetectedHwaccel[] | undefined {
	if (configHw === "nvenc") return [buildResult("nvenc", configDevice, "h264_nvenc", "hevc_nvenc")];

	if (configHw === "vaapi") return [buildResult("vaapi", getDetectedDriDevice(), "h264_vaapi", "hevc_vaapi")];

	if (configHw === "qsv") return [buildResult("qsv", getDetectedDriDevice(), "h264_qsv", "hevc_qsv")];

	if (configHw === "amf") return [buildResult("amf", null, "h264_amf", "hevc_amf")];

	if (configHw === "videotoolbox") return [buildResult("videotoolbox", null, "h264_videotoolbox", "hevc_videotoolbox")];

	if (configHw === "none") return [SOFTWARE_HWACCEL];

	return undefined;
}

/** The accelerators the FFmpeg probe reports as usable. */
function detectedHwaccels(
	encoders: ReadonlySet<string>,
	hwaccels: ReadonlySet<string>,
	configDevice: string | null,
	buildResult: (type: HwaccelType, device: string | null, h264: string, hevc: string) => DetectedHwaccel,
): DetectedHwaccel[] {
	const driDevice = getDetectedDriDevice();
	const candidates: DetectedHwaccel[] = [];

	if (encoders.has("h264_nvenc") && (hwaccels.has("cuda") || hwaccels.has("nvdec") || hwaccels.has("cuvid") || hwaccels.size === 0)) {
		candidates.push(buildResult("nvenc", configDevice, "h264_nvenc", "hevc_nvenc"));
	}

	if (encoders.has("h264_qsv") && (hwaccels.has("qsv") || driDevice !== null) && (driDevice !== null || process.platform !== "linux")) {
		candidates.push(buildResult("qsv", driDevice, "h264_qsv", "hevc_qsv"));
	}

	if (encoders.has("h264_vaapi") && (hwaccels.has("vaapi") || driDevice !== null) && (driDevice !== null || process.platform !== "linux")) {
		candidates.push(buildResult("vaapi", driDevice, "h264_vaapi", "hevc_vaapi"));
	}

	if (encoders.has("h264_amf") && (hwaccels.has("amf") || hwaccels.has("d3d11va") || hwaccels.size === 0)) {
		candidates.push(buildResult("amf", null, "h264_amf", "hevc_amf"));
	}

	if (process.platform === "darwin" && encoders.has("h264_videotoolbox")) {
		candidates.push(buildResult("videotoolbox", null, "h264_videotoolbox", "hevc_videotoolbox"));
	}

	return candidates;
}

/** The accelerator the configured or detected preference picks, before any test encode. */
export function resolveEffectiveHwaccel(encoders: ReadonlySet<string>, hwaccels: ReadonlySet<string>): DetectedHwaccel {
	const candidates = getCandidateHwaccels(encoders, hwaccels);

	return candidates[0] ?? SOFTWARE_HWACCEL;
}
