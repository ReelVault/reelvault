import { SystemSettingsCreator } from "../system-settings.utils";

export type FfmpegHwaccelOption = "auto" | "none" | "nvenc" | "vaapi" | "qsv" | "amf" | "videotoolbox";
type FfmpegPresetOption = "auto" | "ultrafast" | "superfast" | "veryfast" | "faster" | "fast" | "medium" | "slow" | "slower" | "veryslow";
type FfmpegToneMappingOption = "auto" | "none";
type FfmpegToneMapAlgorithmOption = "bt2390" | "hable" | "mobius" | "reinhard";

const FFMPEG_HWACCEL_OPTIONS: readonly FfmpegHwaccelOption[] = ["auto", "none", "nvenc", "vaapi", "qsv", "amf", "videotoolbox"];

const FFMPEG_PRESET_OPTIONS: readonly FfmpegPresetOption[] = [
	"auto",
	"ultrafast",
	"superfast",
	"veryfast",
	"faster",
	"fast",
	"medium",
	"slow",
	"slower",
	"veryslow",
];

const FFMPEG_TONE_MAPPING_OPTIONS: readonly FfmpegToneMappingOption[] = ["auto", "none"];
const FFMPEG_TONE_MAP_ALGORITHM_OPTIONS: readonly FfmpegToneMapAlgorithmOption[] = ["bt2390", "hable", "mobius", "reinhard"];

const creator = SystemSettingsCreator("streaming");

export const STREAMING_SETTINGS_DEFINITIONS = {
	"ffmpeg.path": creator.string("ffmpeg.path", "ffmpeg"),
	"ffmpeg.preset": creator.enum("ffmpeg.preset", [...FFMPEG_PRESET_OPTIONS], "veryfast"),

	"ffmpeg.crf": creator.number("ffmpeg.crf", 0, 51, 23),
	"ffmpeg.threads": creator.number("ffmpeg.threads", 0, 64, 0),

	"ffmpeg.hwaccel": creator.enum("ffmpeg.hwaccel", [...FFMPEG_HWACCEL_OPTIONS], "auto"),
	"ffmpeg.hwaccelDevice": creator.string("ffmpeg.hwaccelDevice", ""),
	// `auto` = tone-map HDR10/HLG/DV sources to SDR during transcode when a
	// supported filter (tonemapx / zscale+tonemap) is available in this ffmpeg.
	"ffmpeg.toneMapping": creator.enum("ffmpeg.toneMapping", [...FFMPEG_TONE_MAPPING_OPTIONS], "auto"),
	"ffmpeg.toneMapAlgorithm": creator.enum("ffmpeg.toneMapAlgorithm", [...FFMPEG_TONE_MAP_ALGORITHM_OPTIONS], "bt2390"),
	"ffmpeg.gracefulShutdownTimeoutMs": creator.number("ffmpeg.gracefulShutdownTimeoutMs", 1000, Number.MAX_SAFE_INTEGER, 5000),

	"stream.maxSessions": creator.number("stream.maxSessions", 1, 100, 5),
	"stream.maxSessionsPerUser": creator.number("stream.maxSessionsPerUser", 1, 100, 3),
	"stream.maxPerStreamBandwidthKbps": creator.number("stream.maxPerStreamBandwidthKbps", 0, Number.MAX_SAFE_INTEGER, 0),
	"stream.hlsSegmentDurationSeconds": creator.number("stream.hlsSegmentDurationSeconds", 1, 30, 6),
	// 90 s = 6× heartbeat (10 s) — covers hidden-tab timer throttling (~1/min)
	// without holding dead sessions longer than a browser outage would justify.
	"stream.inactivityTimeoutMs": creator.number("stream.inactivityTimeoutMs", 5000, Number.MAX_SAFE_INTEGER, 90_000),

	"stream.smartAudioTrackSelection": creator.boolean("stream.smartAudioTrackSelection", true),
} as const;
