import type { ProbeBudget } from "./ffprobe.types";

const MP4_CONTAINER_RE = /\bmov\b|\bmp4\b|\bm4v\b/;
const MATROSKA_CONTAINER_RE = /matroska|webm/;

/**
 * Full fallback budgets — 10-20× ffmpeg's own defaults. Only containers known
 * to hide streams late (MPEG-TS, VOB, RMVB…) should ever pay them; a session
 * that fails to produce its init segment retries once with these.
 */
export const FULL_PROBE_BUDGET: ProbeBudget = { analyzeduration: "50M", probesize: "100M" };

/**
 * Probe budgets tiered by the container ffprobe already identified at ingest
 * (stored in `media_files.format_name`). Well-behaved MP4/MKV only need header
 * reads — the old fixed 50M/100M budget could read 100 MB before the first
 * segment on every session start AND every seek. On slow storage that was
 * seconds of pure I/O; on fast NVMe it was nothing — which is exactly why this
 * tiers by container instead of one static value.
 */
export function probeBudgetForFormat(formatName?: string | null): ProbeBudget {
	const f = (formatName ?? "").toLowerCase();
	if (MP4_CONTAINER_RE.test(f)) return { analyzeduration: "10M", probesize: "10M" };

	if (MATROSKA_CONTAINER_RE.test(f)) return { analyzeduration: "20M", probesize: "20M" };

	return FULL_PROBE_BUDGET;
}
