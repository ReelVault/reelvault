export const SEGMENT_PREFIX = "seg_";
export const SEGMENT_SUFFIX = ".m4s";
export const INIT_SEGMENT_FILE_NAME = "init.mp4";
export const PLAYLIST_FILE_NAME = "playlist.m3u8";
/** ffmpeg `-hls_segment_filename` printf pattern; `%d` is replaced with the segment number. */
export const SEGMENT_OUTPUT_PATTERN = `${SEGMENT_PREFIX}%d${SEGMENT_SUFFIX}`;

const SEGMENT_SUFFIX_ESCAPED = SEGMENT_SUFFIX.replace(".", "\\.");
/** Exact server-generated segment names accepted by the segments route. */
const SEGMENT_NAME_PATTERN = new RegExp(`^${SEGMENT_PREFIX}\\d+${SEGMENT_SUFFIX_ESCAPED}$`);
/** Segment URI inside an HLS playlist line (optional path prefix and query). */
const SEGMENT_URI_PATTERN = new RegExp(`(?:^|/)${SEGMENT_PREFIX}(\\d+)${SEGMENT_SUFFIX_ESCAPED}(?:\\?.*)?$`);

/** True for the server-generated names the segments route accepts (`init.mp4` or `seg_N.m4s`). */
export function isSegmentFile(segmentName: string): boolean {
	return segmentName === INIT_SEGMENT_FILE_NAME || SEGMENT_NAME_PATTERN.test(segmentName);
}

/** Segment index from a playlist URI line, or null for non-segment lines. */
export function parseSegmentUriIndex(uri: string): number | null {
	const index = SEGMENT_URI_PATTERN.exec(uri)?.[1];

	return index === undefined ? null : Number(index);
}

// seg_N.m4s is a server-generated fixed format. A/B-benchmarked ~2x faster
// than regex matching (scripts/benchmarks micro suite); the NaN guard keeps
// the {index: 0, startTime: 0} fallback for non-segment names.
export function parseSegmentName(segmentName: string, segmentDuration: number): { startTime: number; index: number } {
	if (!(segmentName.startsWith(SEGMENT_PREFIX) && segmentName.endsWith(SEGMENT_SUFFIX))) {
		return { index: 0, startTime: 0 };
	}

	const index = Number.parseInt(segmentName.slice(SEGMENT_PREFIX.length, -SEGMENT_SUFFIX.length), 10);
	if (!Number.isInteger(index) || index < 0) {
		return { index: 0, startTime: 0 };
	}

	return { index, startTime: index * segmentDuration };
}
