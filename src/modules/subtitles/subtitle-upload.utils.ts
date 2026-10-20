export type UploadedSubtitleFormat = "srt" | "vtt" | "ass";

const SRT_TIMING = /\d{1,2}:\d{2}:\d{2}[,.]\d{3} --> \d{1,2}:\d{2}:\d{2}[,.]\d{3}/;
const UTF8_BOM = /^\uFEFF/;

/**
 * Recognises an uploaded text subtitle by its extension and checks that the text really is that format, so a renamed
 * file is refused instead of being stored as a track the player cannot read.
 */
export function detectUploadedSubtitleFormat(fileName: string, text: string): UploadedSubtitleFormat | null {
	const extension = fileName.split(".").pop()?.toLowerCase();
	if (extension === "srt") return SRT_TIMING.test(text) ? "srt" : null;
	if (extension === "vtt") {
		// A UTF-8 BOM is common in WebVTT files and is not whitespace for trimStart.
		const header = text.replace(UTF8_BOM, "").trimStart();

		return header.startsWith("WEBVTT") ? "vtt" : null;
	}
	if (extension === "ass") return text.includes("[Events]") ? "ass" : null;

	return null;
}
