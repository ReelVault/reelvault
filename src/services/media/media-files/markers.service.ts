import type { CreateMediaMarker, MediaMarker, MediaMarkerFilters } from "@reelvault/sdk/common";
import { toPublicMarker } from "@/integrations/drizzle-orm/utils/media-marker.mapper";
import { mediaRepository } from "@/repositories/media-files.repository";
import { mediaMarkersRepository } from "@/repositories/media-markers.repository";
import { recordAuditSafe } from "@/services/admin/admin-audit.service";
import type { AdminAuditContext } from "@/services/admin/audit-context.types";
import {
	groupMarkersByMediaFile,
	MARKER_TRANSFER_MAX_LINES,
	parseMarkersNdjson,
	serializeMarkersNdjson,
} from "@/services/media/media-files/marker-transfer.utils";
import { assertExists, DomainError } from "@/utils/domain.errors";
import { runSafely } from "@/utils/safe-execute.utils";
import { mediaFilesLog } from "./media-files.logger";
import { assertMediaFileExists } from "./queries.reader";

/** Every marker matching the filters as NDJSON; an export past the cap is refused rather than cut short. */
export async function exportMarkers(query: MediaMarkerFilters): Promise<string> {
	return await runSafely(mediaFilesLog, "exportMarkers", async () => {
		const markers = await mediaMarkersRepository.findAll({ ...query, limit: MARKER_TRANSFER_MAX_LINES + 1 });
		if (markers.length > MARKER_TRANSFER_MAX_LINES) {
			throw new DomainError("validation", `The marker export holds at most ${MARKER_TRANSFER_MAX_LINES} markers; narrow the filters`, {
				code: "media.markers_export_too_large",
				params: { limit: MARKER_TRANSFER_MAX_LINES },
			});
		}

		return serializeMarkersNdjson(markers.map((item) => toPublicMarker(item)));
	});
}

/**
 * Replaces the markers of every media file the NDJSON names in one pass. Every file and every range is
 * checked before the first marker is written, so an unknown file or an invalid range refuses the whole
 * import (the old per-file loop could stop halfway).
 */
export async function importMarkers(text: string, context?: AdminAuditContext): Promise<{ mediaFiles: number; markers: number }> {
	return await runSafely(mediaFilesLog, "importMarkers", async () => {
		const grouped = groupMarkersByMediaFile(parseMarkersNdjson(text));
		const mediaFileIds = [...grouped.keys()];

		const existing = await mediaRepository.findExistingIds(mediaFileIds);
		const missing = mediaFileIds.find((mediaFileId) => !existing.has(mediaFileId));
		if (missing !== undefined) {
			throw new DomainError("validation", `The marker import names an unknown media file: ${missing}`, {
				code: "media.markers_import_unknown_file",
				params: { mediaFileId: missing },
			});
		}
		const snapshots = await mediaMarkersRepository.replaceMarkersForMediaFiles(grouped);
		let markers = 0;
		for (const [mediaFileId, items] of grouped) {
			markers += items.length;
			const snapshot = snapshots.get(mediaFileId);
			recordAuditSafe(
				{
					action: "update",
					resourceType: "media_markers",
					resourceId: mediaFileId,
					before: (snapshot?.before ?? []).map((item) => toPublicMarker(item)),
					after: (snapshot?.after ?? []).map((item) => toPublicMarker(item)),
					context,
				},
				mediaFilesLog.logger,
			);
		}

		return { mediaFiles: grouped.size, markers };
	});
}

export async function setMarkers(
	mediaFileId: string,
	markers: readonly CreateMediaMarker[],
	options?: { pluginId?: string; source?: "automatic" | "manual" | "plugin" },
	context?: AdminAuditContext,
): Promise<MediaMarker[]> {
	return await runSafely(mediaFilesLog, "setMarkers", async () => {
		// Server-owned semantic validation (moved out of the SDK client).
		const invalid = markers.find((marker) => marker.endSeconds < marker.startSeconds);
		if (invalid)
			throw new DomainError("validation", `Marker end must not precede its start (${invalid.type})`, {
				code: "media_file.marker_range_invalid",
			});

		const [mediaFileExists, before] = await Promise.all([
			mediaRepository.isExists({ primaryId: mediaFileId }),
			mediaMarkersRepository.findByMediaFileId(mediaFileId),
		]);
		assertExists(mediaFileExists, "MediaFile", mediaFileId);
		const saved = await mediaMarkersRepository.replaceMarkersForMediaFile(mediaFileId, markers, options);
		const after = saved.map((item) => toPublicMarker(item));

		recordAuditSafe(
			{
				action: "update",
				resourceType: "media_markers",
				resourceId: mediaFileId,
				before: before.map((item) => toPublicMarker(item)),
				after,
				context,
			},
			mediaFilesLog.logger,
		);

		return after;
	});
}

export async function deleteMarkers(mediaFileId: string, context?: AdminAuditContext): Promise<{ success: boolean }> {
	return await runSafely(mediaFilesLog, "deleteMarkers", async () => {
		await assertMediaFileExists(mediaFileId);
		const before = await mediaMarkersRepository.findByMediaFileId(mediaFileId);
		await mediaMarkersRepository.deleteByMediaFileId(mediaFileId);

		recordAuditSafe(
			{
				action: "delete",
				resourceType: "media_markers",
				resourceId: mediaFileId,
				before: before.map((item) => toPublicMarker(item)),
				context,
			},
			mediaFilesLog.logger,
		);

		return { success: true };
	});
}
