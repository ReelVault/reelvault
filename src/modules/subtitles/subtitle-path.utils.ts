import { joinPath } from "@/utils/path.utils";

/** Cache path of the WebVTT rendition extracted for a subtitle row. */
export function subtitleVttPath(subtitlesPath: string, subtitleId: string): string {
	return joinPath(subtitlesPath, `${subtitleId}.vtt`);
}
