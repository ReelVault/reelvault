export const VIDEO_CODEC_MAP: Record<string, string> = {
	h264: "h264",
	avc: "h264",
	avc1: "h264",
	h265: "h265",
	hevc: "h265",
	hvc1: "h265",
	av1: "av1",
	av01: "av1",
	vp9: "vp9",
	vp09: "vp9",
	vp8: "vp8",
	vp08: "vp8",
	mpeg2video: "mpeg2",
	mpeg4: "mpeg4",
	xvid: "mpeg4",
	divx: "mpeg4",
	wmv3: "wmv",
};

export const AUDIO_CODEC_MAP: Record<string, string> = {
	aac: "aac",
	mp3: "mp3",
	mp2: "mp3",
	opus: "opus",
	vorbis: "vorbis",
	ac3: "ac3",
	eac3: "eac3",
	"e-ac-3": "eac3",
	truehd: "truehd",
	dts: "dts",
	dca: "dts",
	dtshd: "dts",
	flac: "flac",
	pcm_s16le: "pcm",
	pcm_s24le: "pcm",
	pcm_s32le: "pcm",
	alac: "alac",
};

export function normalizeCodec(codec: string | null, map: Record<string, string>): string | null {
	if (!codec) return null;

	const lower = codec.toLowerCase();

	return map[lower] ?? lower;
}

/**
 * HDR transfer characteristics a client may declare for passthrough.
 * Anything else in the reported list is dropped by the capability parser.
 */
export const HDR_TRANSFER_ALLOWLIST: ReadonlySet<string> = new Set(["smpte2084", "arib-std-b67"]);
