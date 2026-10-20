/**
 * Domain rules about media metadata that several layers need: the app, the
 * workers and the plugins. They live in `utils/` because those layers cannot
 * import each other, and they are not about types or arithmetic.
 */

/** Maps a library type string (`"movies"` / `"tv"`) to the canonical media type. */
export function mapLibraryType(libraryType: string): "movie" | "tv_show" {
	return libraryType === "movies" ? "movie" : "tv_show";
}

/**
 * Checks whether a rating has a non-empty source and a finite numeric value.
 * A rating without a source cannot be attributed, and a non-finite value
 * cannot be averaged.
 */
export function isValidRating(rating: { source: string; value: number }): boolean {
	return rating.source.trim().length > 0 && Number.isFinite(rating.value);
}
