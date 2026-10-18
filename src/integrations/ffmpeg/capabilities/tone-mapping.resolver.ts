export type ToneMappingMethod = "tonemapx" | "zscale" | "none";

/** Resolved tone-mapping inputs for the transcode arg builders. */
export interface ToneMapConfig {
	method: ToneMappingMethod;
	algorithm: string;
}

/**
 * Picks the best available HDR→SDR tone-mapping filter pair for this ffmpeg
 * build: `tonemapx` (jellyfin-ffmpeg, self-contained) or the classic
 * `zscale`+`tonemap` (zimg) combo. `none` = no usable filter, transcode runs
 * without tone-mapping (legacy behavior).
 */
export function resolveToneMappingMethod(filters: ReadonlySet<string>): ToneMappingMethod {
	if (filters.has("tonemapx")) return "tonemapx";

	if (filters.has("zscale") && filters.has("tonemap")) return "zscale";

	return "none";
}
