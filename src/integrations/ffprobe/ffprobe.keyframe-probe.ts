import { fileVersionSignature } from "@/utils/file.utils";
import { MemoryCache } from "@/utils/memory.cache";
import { ffProbeService } from "./ffprobe.service";
import type { FFProbePacket } from "./ffprobe.types";

const PROBE_WINDOW_SECONDS = 15;
const PTS_EPSILON = 0.001;

// Scrubbing re-seeks around the same positions. Probe once per 2 s bucket and
// keep the packet list: every target in that bucket answers from it, and a
// bucket containing no keyframes is cached as an empty list (a miss is repeatable).
const KEYFRAME_BUCKET_SECONDS = 2;
const keyframeCache = new MemoryCache<FFProbePacket[]>({ ttlMs: 30 * 60_000, maxSize: 2000, name: "keyframes" });

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
	// previous content's packets for the whole TTL. Probing up to the bucket end
	// covers every target that shares the key; pickLastKeyframe still filters by
	// the exact target, so an earlier seek can never receive a later keyframe.
	const signature = await fileVersionSignature(filePath);
	const bucketEnd = Math.ceil(target / KEYFRAME_BUCKET_SECONDS) * KEYFRAME_BUCKET_SECONDS;
	const cacheKey = `${filePath}:${signature}:${bucketEnd}`;
	const packets = await keyframeCache.getOrSet(cacheKey, async () => {
		try {
			// Cover the full look-back of the earliest target in this bucket.
			const from = Math.max(0, bucketEnd - KEYFRAME_BUCKET_SECONDS - PROBE_WINDOW_SECONDS);
			// A packet listing, not a format probe: ffprobe answers
			// `-show_entries packet=…` with the packets alone.
			return await ffProbeService
				.create()
				.addArg("-read_intervals", `${from}%${bucketEnd}`)
				.selectStreams("v")
				.addArg("-show_entries", "packet=pts_time,flags")
				.executePackets(filePath, signal);
		} catch (error) {
			// An aborted probe is not a result: `getOrSet` only caches successes, so
			// rethrowing keeps the bucket probeable instead of pinning "no keyframe"
			// for the whole TTL (which would silently disable keyframe seeks).
			if (signal?.aborted) throw error;

			return [];
		}
	});

	// The bucket's probe window starts earlier than this target's own 15 s
	// look-back; enforce the per-target bound before picking a keyframe.
	const earliest = target - PROBE_WINDOW_SECONDS;
	const inRange = packets.filter((packet) => {
		const pts = Number.parseFloat(packet.pts_time ?? "");

		return !Number.isNaN(pts) && pts >= earliest - PTS_EPSILON;
	});

	return pickLastKeyframePackets(inRange, target);
}
