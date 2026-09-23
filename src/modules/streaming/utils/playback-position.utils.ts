// Pure playback-position calculations — shared by progress/ and segments.
import { clamp } from "@/utils/math.utils";
import { isFiniteNumber } from "@/utils/type.utils";

const COMPLETION_THRESHOLD = 0.9;

export function normalizePlaybackPosition(position: number | null | undefined, duration: number): number {
	// Server-side normalization: non-finite or missing positions collapse to 0,
	// out-of-range positions clamp to the file duration.
	const requested = isFiniteNumber(position) ? position : 0;
	const floored = Math.floor(requested);

	// `duration > 0` mirrors the old `duration || …` fallback for NaN/0/negative.
	return duration > 0 ? clamp(floored, 0, duration) : Math.max(0, floored);
}

export function isCompleted(position: number, duration: number): boolean {
	return duration > 0 && position / duration >= COMPLETION_THRESHOLD;
}

export function computeProgressPercent(position: number, duration: number | null | undefined): number {
	return duration != null && duration > 0 ? Math.min(100, Math.round((position / duration) * 100)) : 0;
}
