export const UNSUPPORTED_ARTWORK_REGEX = /(?:clear)?logo|banner/i;

/** Artwork names the reader accepts and the exporter writes — one vocabulary for both directions. */
export const TITLE_POSTER_NAMES = ["folder.jpg", "poster.jpg"] as const;
export const TITLE_BACKDROP_NAMES = ["backdrop.jpg", "landscape.jpg", "fanart.jpg"] as const;

export function episodeThumbFileName(baseName: string): string {
	return `${baseName}-thumb.jpg`;
}
