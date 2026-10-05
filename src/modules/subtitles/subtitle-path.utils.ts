import { PathUtils } from "@/utils/path.utils";

/** Cache path of the WebVTT rendition extracted for a subtitle row. */
export function subtitleVttPath(subtitlesPath: string, subtitleId: string): string {
	return PathUtils.join(subtitlesPath, `${subtitleId}.vtt`);
}
