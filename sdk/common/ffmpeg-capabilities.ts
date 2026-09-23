import { t } from "elysia";

export const FfmpegHwaccelTypeSchema = t.Union([
	t.Literal("none"),
	t.Literal("nvenc"),
	t.Literal("vaapi"),
	t.Literal("qsv"),
	t.Literal("amf"),
	t.Literal("videotoolbox"),
]);

export const FfmpegHwaccelInfoSchema = t.Object({
	type: FfmpegHwaccelTypeSchema,
	/** Device path passed to FFmpeg (DRM render node for vaapi/qsv). `null` also means "not applicable" — CUDA does not use /dev/dri. */
	device: t.Nullable(t.String()),
	h264Encoder: t.String(),
	hevcEncoder: t.String(),
});

/** Result of the startup test encode proving the effective encoder can actually run. */
export const FfmpegVerificationSchema = t.Object({
	encoder: t.String(),
	ok: t.Boolean(),
	/** Stable failure code; `null` on success. */
	code: t.Nullable(t.String()),
	/** Raw FFmpeg stderr tail (developer detail, not translated). */
	detail: t.Nullable(t.String()),
});

/** Result of the on-demand test decode proving the accelerator's decoder works. */
export const FfmpegDecodeTestSchema = t.Object({
	accelerator: FfmpegHwaccelTypeSchema,
	ok: t.Boolean(),
	code: t.Nullable(t.String()),
	detail: t.Nullable(t.String()),
});

export type FfmpegDecodeTest = typeof FfmpegDecodeTestSchema.static;

export const AdminFfmpegCapabilitiesSchema = t.Object({
	/** FFmpeg version string as reported by `ffmpeg -version`. */
	version: t.String(),
	binaryPath: t.String(),
	/** hwaccel setting chosen in the admin panel ("auto" means server-side detection). */
	configured: t.Union([t.Literal("auto"), FfmpegHwaccelTypeSchema]),
	/** Accelerator the server actually uses for streaming/transcoding right now. */
	effective: FfmpegHwaccelInfoSchema,
	/** Test-encode verification of the detected accelerator (null when nothing to verify). */
	verification: t.Nullable(FfmpegVerificationSchema),
	/** Last on-demand decode test (refresh endpoint); null until the first refresh in this server run. */
	decodeTest: t.Nullable(FfmpegDecodeTestSchema),
	/** Hardware acceleration APIs reported by `ffmpeg -hwaccels`. */
	hwaccelApis: t.Array(t.String()),
	/** Encoders relevant to hardware acceleration (e.g. h264_nvenc, hevc_vaapi). */
	hardwareEncoders: t.Array(t.String()),
	/** DRM device auto-detected for vaapi/qsv, if any. */
	driDevice: t.Nullable(t.String()),
	/** HDR→SDR tone-mapping filter method available in this ffmpeg build. */
	toneMappingMethod: t.Union([t.Literal("tonemapx"), t.Literal("zscale"), t.Literal("none")]),
	/** Tone-mapping mode setting (`auto` uses the method above for HDR sources). */
	toneMapping: t.Union([t.Literal("auto"), t.Literal("none")]),
	toneMapAlgorithm: t.Union([t.Literal("bt2390"), t.Literal("hable"), t.Literal("mobius"), t.Literal("reinhard")]),
});

export type AdminFfmpegCapabilities = typeof AdminFfmpegCapabilitiesSchema.static;
