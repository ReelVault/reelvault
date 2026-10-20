/**
 * The FFmpeg video filters the server builds.
 */

/**
 * Scales the source to fit inside the box and letterbox-pads it to exactly
 * `width`×`height`, so every output of a given size has the same dimensions.
 */
export function buildFitPadFilter(width: number, height: number): string {
	return `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`;
}
