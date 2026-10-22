import type { DownloadRow } from "@/repositories/downloads.repository";
import { toErrorCode } from "@/utils/domain.errors";

export interface DownloadJobView {
	id: string;
	mediaFileId: string;
	/** Title the media file belongs to; null when it no longer has one. */
	metadataId: string | null;
	quality: string;
	status: string;
	progressPercent: number;
	sizeBytes: number | null;
	fileName: string | null;
	downloadUrl: string | null;
	errorCode: string | null;
	createdAt: string;
	updatedAt: string;
}

export function toDownloadView(row: DownloadRow, metadataId: string | null): DownloadJobView {
	return {
		id: row.id,
		mediaFileId: row.mediaFileId,
		metadataId,
		quality: row.quality,
		status: row.status,
		progressPercent: row.progressPercent,
		sizeBytes: row.sizeBytes,
		fileName: row.fileName,
		downloadUrl: row.status === "completed" ? `/v1/downloads/${row.id}/file` : null,
		errorCode: toErrorCode(row.errorText, "download.failed"),
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}
