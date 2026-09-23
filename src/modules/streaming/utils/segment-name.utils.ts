const PREFIX = "seg_";
const SUFFIX = ".m4s";

// seg_N.m4s is a server-generated fixed format. A/B-benchmarked ~2x faster
// than regex matching (scripts/benchmarks micro suite); the NaN guard keeps
// the {index: 0, startTime: 0} fallback for non-segment names.
export function parseSegmentName(segmentName: string, segmentDuration: number): { startTime: number; index: number } {
	if (!(segmentName.startsWith(PREFIX) && segmentName.endsWith(SUFFIX))) {
		return { index: 0, startTime: 0 };
	}

	const index = Number.parseInt(segmentName.slice(PREFIX.length, -SUFFIX.length), 10);
	if (!Number.isInteger(index) || index < 0) {
		return { index: 0, startTime: 0 };
	}

	return { index, startTime: index * segmentDuration };
}
