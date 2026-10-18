import { normalizeLower } from "@/utils/type.utils";

const BITMAP_SUBTITLE_FORMATS = new Set([
	"hdmv_pgs_subtitle",
	"pgssub",
	"pgs",
	"dvd_subtitle",
	"dvdsub",
	"vobsub",
	"xsub",
	"dvb_subtitle",
	"dvb_teletext",
	"arib_caption",
]);

export function isBitmapSubtitleFormat(format?: string | null): boolean {
	if (!format) return false;

	const normalized = normalizeLower(format);

	return BITMAP_SUBTITLE_FORMATS.has(normalized.startsWith(".") ? normalized.slice(1) : normalized);
}

export function buildWebVttExtractionArgs(mediaFilePath: string, streamIndex: number, outputFilePath: string): string[] {
	return ["-nostdin", "-loglevel", "error", "-y", "-i", mediaFilePath, "-map", `0:${streamIndex}`, "-f", "webvtt", outputFilePath];
}
