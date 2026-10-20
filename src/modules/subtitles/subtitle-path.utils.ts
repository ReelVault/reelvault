import { join } from "node:path";
/** Cache path of the WebVTT rendition extracted for a subtitle row. */
export function subtitleVttPath(subtitlesPath: string, subtitleId: string): string {
	return join(subtitlesPath, `${subtitleId}.vtt`);
}
