import { FileUtils, fileStatSignature } from "@/utils/file.utils";
import { MemoryCache } from "@/utils/memory-cache";
import { ffProbeService } from "./ffprobe.service";
import type { FFProbePacket } from "./ffprobe.types";

const PROBE_WINDOW_SECONDS = 15;
const PTS_EPSILON = 0.001;

// Scrubbing re-seeks around the same positions — cache probe results per 2 s
// bucket so repeat seeks skip the ffprobe spawn entirely (misses cached too:
// a 15 s window without keyframes is just as repeatable).
const KEYFRAME_CACHE_BUCKET_SECONDS = 2;
const keyframeCache = new MemoryCache<number>({ ttlMs: 30 * 60_000, maxSize: 2000, name: "keyframes" });

/**
 * Returns the last keyframe packet with pts_time <= limit (small tolerance for
 * float rounding), or null when the window holds no usable keyframe.
 */
export function pickLastKeyframePackets(packets: FFProbePacket[], limit: number): number | null {
	let result: number | null = null;
	for (const packet of packets) {
		const pts = Number.parseFloat(packet.pts_time ?? "");
		if (Number.isNaN(pts) || pts > limit + PTS_EPSILON) continue;

		if (packet.flags?.startsWith("K")) result = pts;
	}

	return result;
}

/**
 * Probes the input file around `target` seconds to find the nearest keyframe
 * (I-frame / IDR) packet strictly before or at that position.
 * null = could not be determined; callers must fall back to `target`.
 */
export async function findKeyframeBefore(filePath: string, target: number, signal?: AbortSignal): Promise<number | null> {
	if (target <= 0) return null;

	// The file's (size, mtime) signature keeps a replaced file from serving the
	// previous content's keyframe buckets for the whole TTL.
	const stats = await FileUtils.getStats(filePath);
	const signature = stats ? fileStatSignature(stats) : "0";
	const cacheKey = `${filePath}:${signature}:${Math.floor(target / KEYFRAME_CACHE_BUCKET_SECONDS)}`;
	const cached = await keyframeCache.getOrSet(cacheKey, async () => {
		try {
			const from = Math.max(0, target - PROBE_WINDOW_SECONDS);
			const probe = await ffProbeService
				.create()
				.addArg("-read_intervals", `${from}%${target}`)
				.selectStreams("v")
				.addArg("-show_entries", "packet=pts_time,flags")
				.execute(filePath, signal);
			const keyframe = pickLastKeyframePackets(probe.packets ?? [], target);

			return keyframe ?? 0;
		} catch (error) {
			// An aborted probe is not a result: `getOrSet` only caches successes, so
			// rethrowing keeps the bucket probeable instead of pinning "no keyframe"
			// for the whole TTL (which would silently disable keyframe seeks).
			if (signal?.aborted) throw error;

			return 0;
		}
	});

	return cached > 0 ? cached : null;
}
