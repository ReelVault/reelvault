// Pure playback-position calculations — shared by progress/ and segments.
import { clamp } from "@/utils/math.utils";
import { isFiniteNumber, isNullish } from "@/utils/type.utils";

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

/**
 * Media time played between two heartbeats. The position moves only while the stream plays, so a pause adds nothing;
 * a jump forward (a seek) counts at most the wall-clock time between the two heartbeats, and a jump back counts nothing.
 */
export function playedSecondsBetween(previous: { position: number; at: number } | undefined, position: number, now: number): number {
	if (!previous) return 0;

	const wallSeconds = Math.max(0, (now - previous.at) / 1000);

	return clamp(position - previous.position, 0, wallSeconds);
}

export function computeProgressPercent(position: number, duration: number | null | undefined): number {
	return !isNullish(duration) && duration > 0 ? Math.min(100, Math.round((position / duration) * 100)) : 0;
}
