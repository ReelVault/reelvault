import { clamp } from "@/utils/math.utils";
import { isFiniteNumber } from "@/utils/type.utils";
import type { HlsBufferAnalysis, HlsBufferedSegment, HlsBufferRange } from "../streaming.types";

const SEGMENT_PATTERN = /(?:^|\/)seg_(\d+)\.m4s(?:\?.*)?$/;
const DURATION_PATTERN = /^#EXTINF:([\d.]+)/;
const LINE_SEPARATOR_PATTERN = /\r?\n/;

export function parseHlsBuffer(playlist: string, segmentDuration: number): HlsBufferAnalysis {
	const uniqueByIndex = new Map<number, HlsBufferedSegment>();
	let pendingDuration: number | null = null;
	let complete = false;

	for (const rawLine of playlist.split(LINE_SEPARATOR_PATTERN)) {
		const line = rawLine.trim();
		if (!line) continue;

		if (line === "#EXT-X-ENDLIST") {
			complete = true;
			continue;
		}

		const durationMatch = line.match(DURATION_PATTERN);
		if (durationMatch) {
			const duration = Number(durationMatch[1]);
			pendingDuration = isFiniteNumber(duration) ? duration : null;
			continue;
		}

		if (line.startsWith("#") || pendingDuration === null) continue;

		const segmentMatch = line.match(SEGMENT_PATTERN);
		const duration = pendingDuration;
		pendingDuration = null;
		if (!segmentMatch) continue;

		const segmentIndex = Number(segmentMatch[1]);
		const startTime = segmentIndex * segmentDuration;
		uniqueByIndex.set(segmentIndex, {
			index: segmentIndex,
			startTime,
			endTime: startTime + duration,
			duration,
		});
	}

	const uniqueSegments = [...uniqueByIndex.values()].toSorted((left, right) => left.index - right.index);
	const ranges = createRanges(uniqueSegments);
	const lastRange = ranges[ranges.length - 1];

	return {
		complete,
		segments: uniqueSegments,
		ranges,
		bufferedSeconds: uniqueSegments.reduce((total, segment) => total + segment.duration, 0),
		bufferedUntil: lastRange?.endTime ?? 0,
	};
}

export function isPositionBuffered(analysis: HlsBufferAnalysis, position: number): boolean {
	return analysis.ranges.some((range) => position >= range.startTime && position < range.endTime);
}

export function getBufferedSeekStart(analysis: HlsBufferAnalysis, position: number, segmentDuration: number): number | null {
	return isPositionBuffered(analysis, position) ? Math.floor(Math.max(0, position) / segmentDuration) * segmentDuration : null;
}

export function calculateBufferProgress(bufferedUntil: number, duration: number | null): number | null {
	if (!duration || duration <= 0) return null;

	return clamp(Number(((bufferedUntil / duration) * 100).toFixed(2)), 0, 100);
}

function createRanges(segments: HlsBufferedSegment[]): HlsBufferRange[] {
	const ranges: HlsBufferRange[] = [];

	for (const segment of segments) {
		const lastRange = ranges[ranges.length - 1];
		if (lastRange && segment.index === lastRange.endSegment + 1) {
			lastRange.endSegment = segment.index;
			lastRange.endTime = segment.endTime;
			lastRange.segmentCount++;
			continue;
		}

		ranges.push({
			startTime: segment.startTime,
			endTime: segment.endTime,
			startSegment: segment.index,
			endSegment: segment.index,
			segmentCount: 1,
		});
	}

	return ranges;
}
