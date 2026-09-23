import { findKeyframeBefore } from "@/integrations/ffprobe/ffprobe.keyframe-probe";

/**
 * A direct-stream restart must align to a keyframe at or before the offset — the
 * `-c copy` remux has to start at the cut point, while transcoding starts exactly
 * at the requested offset.
 */
export async function resolveSeekTimelineStart(
	mode: string,
	inputPath: string,
	offset: number,
	probe: (path: string, offset: number) => number | null | Promise<number | null> = findKeyframeBefore,
): Promise<number> {
	if (mode !== "direct-stream") return offset;

	return (await probe(inputPath, offset)) ?? offset;
}
