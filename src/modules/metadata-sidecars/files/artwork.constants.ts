export const UNSUPPORTED_ARTWORK_REGEX = /(?:clear)?logo|banner/i;

/** Artwork names the reader accepts and the exporter writes — one vocabulary for both directions. */
export const EXPORTED_TITLE_POSTER_NAME = "poster.jpg";
export const EXPORTED_TITLE_BACKDROP_NAME = "fanart.jpg";
export const SEASON_POSTER_SUFFIX = "-poster.jpg";

export const TITLE_POSTER_NAMES = ["folder.jpg", EXPORTED_TITLE_POSTER_NAME] as const;
export const TITLE_BACKDROP_NAMES = ["backdrop.jpg", "landscape.jpg", EXPORTED_TITLE_BACKDROP_NAME] as const;

export function episodeThumbFileName(baseName: string): string {
	return `${baseName}-thumb.jpg`;
}
