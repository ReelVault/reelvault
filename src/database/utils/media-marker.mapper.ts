import type { MediaMarker } from "@sdk/common";
import type { InferTable } from "@/database/types";

type MediaMarkerRow = InferTable<"mediaMarkers">;

/**
 * Single mapping from the mediaMarkers table row to the public MediaMarker
 * contract. Shared by the plugins marker capability and the media-files
 * service — previously two identical private copies.
 */
export function toPublicMarker(row: MediaMarkerRow): MediaMarker {
	return {
		id: row.id,
		mediaFileId: row.mediaFileId,
		type: row.type,
		startSeconds: row.startSeconds,
		endSeconds: row.endSeconds,
		label: row.label,
		source: row.source,
		pluginId: row.pluginId,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}
