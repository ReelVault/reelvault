import { systemResourcesService } from "@/system/system-resources.service";
import { clamp } from "@/utils/math.utils";

/** Hard ceiling for the adaptive (unconfigured) per-process thread budget. */
const MAX_ADAPTIVE_THREADS = 8;

/**
 * `-threads` budget for one streaming ffmpeg process.
 *
 * An explicit configured value always wins. Adaptive mode (configured <= 0)
 * divides the machine's ffmpeg thread budget across the concurrent streaming
 * processes so N parallel transcodes cannot each claim every core.
 *
 * `activeTranscodes` counts the streaming processes sharing the budget — the
 * transcode strategy reserves its slot before calling, so the value includes
 * the process being started. Direct-stream remuxing passes 0 deliberately:
 * `-c copy` is I/O-bound, so it keeps the full machine budget un-clamped
 * instead of splitting it.
 */
export function resolveStreamingThreads(configured: number, activeTranscodes: number): number {
	if (configured > 0) return configured;

	const budget = systemResourcesService.getFfmpegThreads();
	if (activeTranscodes <= 0) return budget;

	return clamp(Math.floor(budget / (activeTranscodes + 1)), 1, MAX_ADAPTIVE_THREADS);
}
