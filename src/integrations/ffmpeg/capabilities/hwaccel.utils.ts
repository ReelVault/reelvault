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

interface HwaccelDescriptor {
	readonly h264Encoder: string;
	readonly hevcEncoder: string;
	/** `-hwaccel` value for the input-side decode, or null for software. */
	readonly decodeHwaccel: string | null;
	/** Flag that passes an explicit device to the decoder, when it has one. */
	readonly decodeDeviceFlag: string | null;
	/** Flag that passes an explicit device to the test encoder, when it has one. */
	readonly encodeDeviceFlag: string | null;
}

/**
 * One table for the accelerator families. The encoder pair drives candidate
 * selection, the decode fields drive the input args, and `encodeDeviceFlag`
 * drives the boot test encode — configured and probed candidates share it, so a
 * new family is added in one place. Decoding and encoding use different device
 * flags for some vendors, hence the two fields.
 */
export const HWACCEL_DESCRIPTORS: Readonly<Record<HwaccelType, HwaccelDescriptor>> = {
	none: {
		h264Encoder: SOFTWARE_HWACCEL.h264Encoder,
		hevcEncoder: SOFTWARE_HWACCEL.hevcEncoder,
		decodeHwaccel: null,
		decodeDeviceFlag: null,
		encodeDeviceFlag: null,
	},
	nvenc: {
		h264Encoder: "h264_nvenc",
		hevcEncoder: "hevc_nvenc",
		decodeHwaccel: "cuda",
		decodeDeviceFlag: "-hwaccel_device",
		encodeDeviceFlag: "-gpu",
	},
	vaapi: {
		h264Encoder: "h264_vaapi",
		hevcEncoder: "hevc_vaapi",
		decodeHwaccel: "vaapi",
		decodeDeviceFlag: "-vaapi_device",
		encodeDeviceFlag: "-vaapi_device",
	},
	qsv: {
		h264Encoder: "h264_qsv",
		hevcEncoder: "hevc_qsv",
		decodeHwaccel: "qsv",
		decodeDeviceFlag: "-hwaccel_device",
		encodeDeviceFlag: "-qsv_device",
	},
	amf: {
		h264Encoder: "h264_amf",
		hevcEncoder: "hevc_amf",
		decodeHwaccel: "d3d11va",
		decodeDeviceFlag: null,
		encodeDeviceFlag: null,
	},
	videotoolbox: {
		h264Encoder: "h264_videotoolbox",
		hevcEncoder: "hevc_videotoolbox",
		decodeHwaccel: "videotoolbox",
		decodeDeviceFlag: null,
		encodeDeviceFlag: null,
	},
} as const;

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
	const descriptor = HWACCEL_DESCRIPTORS[hw.type];
	if (!descriptor.decodeHwaccel) return [];

	const args = ["-hwaccel", descriptor.decodeHwaccel];

	return descriptor.decodeDeviceFlag ? [...args, ...withDevice(descriptor.decodeDeviceFlag, hw.device)] : args;
}

/** Accelerators this host could use, in preference order. Encoders and hwaccels come from the FFmpeg probe. */
export function getCandidateHwaccels(encoders: ReadonlySet<string>, hwaccels: ReadonlySet<string>): DetectedHwaccel[] {
	const configHw = serverConfig.ffmpeg.hwaccel;
	const configDevice = serverConfig.ffmpeg.hwaccelDevice.trim() || null;

	const hasEncoder = (name: string) => encoders.size === 0 || encoders.has(name);
	const buildResult = (type: HwaccelType, device: string | null): DetectedHwaccel => {
		const { h264Encoder, hevcEncoder } = HWACCEL_DESCRIPTORS[type];

		return {
			type,
			device,
			h264Encoder: hasEncoder(h264Encoder) ? h264Encoder : SOFTWARE_HWACCEL.h264Encoder,
			hevcEncoder: hasEncoder(hevcEncoder) ? hevcEncoder : SOFTWARE_HWACCEL.hevcEncoder,
		};
	};

	const configured = configuredHwaccel(configHw, configDevice, buildResult);
	if (configured) return configured;

	return detectedHwaccels(encoders, hwaccels, configDevice, buildResult);
}

/** The accelerator the configuration pins, when it pins one. */
function configuredHwaccel(
	configHw: string,
	configDevice: string | null,
	buildResult: (type: HwaccelType, device: string | null) => DetectedHwaccel,
): DetectedHwaccel[] | undefined {
	if (configHw === "nvenc") return [buildResult("nvenc", configDevice)];

	if (configHw === "vaapi") return [buildResult("vaapi", getDetectedDriDevice())];

	if (configHw === "qsv") return [buildResult("qsv", getDetectedDriDevice())];

	if (configHw === "amf") return [buildResult("amf", null)];

	if (configHw === "videotoolbox") return [buildResult("videotoolbox", null)];

	if (configHw === "none") return [SOFTWARE_HWACCEL];

	return undefined;
}

/** The accelerators the FFmpeg probe reports as usable. */
function detectedHwaccels(
	encoders: ReadonlySet<string>,
	hwaccels: ReadonlySet<string>,
	configDevice: string | null,
	buildResult: (type: HwaccelType, device: string | null) => DetectedHwaccel,
): DetectedHwaccel[] {
	const driDevice = getDetectedDriDevice();
	const candidates: DetectedHwaccel[] = [];

	if (
		encoders.has(HWACCEL_DESCRIPTORS.nvenc.h264Encoder) &&
		(hwaccels.has("cuda") || hwaccels.has("nvdec") || hwaccels.has("cuvid") || hwaccels.size === 0)
	) {
		candidates.push(buildResult("nvenc", configDevice));
	}

	if (
		encoders.has(HWACCEL_DESCRIPTORS.qsv.h264Encoder) &&
		(hwaccels.has("qsv") || driDevice !== null) &&
		(driDevice !== null || process.platform !== "linux")
	) {
		candidates.push(buildResult("qsv", driDevice));
	}

	if (
		encoders.has(HWACCEL_DESCRIPTORS.vaapi.h264Encoder) &&
		(hwaccels.has("vaapi") || driDevice !== null) &&
		(driDevice !== null || process.platform !== "linux")
	) {
		candidates.push(buildResult("vaapi", driDevice));
	}

	if (encoders.has(HWACCEL_DESCRIPTORS.amf.h264Encoder) && (hwaccels.has("amf") || hwaccels.has("d3d11va") || hwaccels.size === 0)) {
		candidates.push(buildResult("amf", null));
	}

	if (process.platform === "darwin" && encoders.has(HWACCEL_DESCRIPTORS.videotoolbox.h264Encoder)) {
		candidates.push(buildResult("videotoolbox", null));
	}

	return candidates;
}
