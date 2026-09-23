import { clamp } from "@/utils/math.utils";
import { isFiniteNumber } from "@/utils/type.utils";

/**
 * Seeks never target the exact end of the input: ffmpeg input-seeking to (or
 * past) the real last packet consumes zero packets, exits 0 and never writes
 * the playlist — a permanently dead session. Stored durations can also exceed
 * the actual playable content, so the guard keeps a visible margin instead of
 * trusting metadata to be exact.
 */
export const SEEK_EOF_GUARD_SECONDS = 1;

export function clampSeekOffsetToDuration(offset: number, durationSeconds?: number | null): number {
	// The only offset clamp for seeks: floor at 0 (and reject NaN) here so callers
	// do not need their own `Math.max(0, …)` before aligning to a segment.
	if (!isFiniteNumber(offset) || offset <= 0) return 0;

	if (!durationSeconds || durationSeconds <= 0) return offset;

	// offset is already finite and > 0, so clamp() is a plain min/max here.
	return clamp(offset, 0, Math.max(0, durationSeconds - SEEK_EOF_GUARD_SECONDS));
}
