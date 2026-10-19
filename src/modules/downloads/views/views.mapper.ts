import { type DownloadRecord, downloadsStorage } from "@/modules/downloads/downloads.ports";
import { toMap } from "@/utils/array.utils";
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

/** Media file id → title id for the rows' media files, in one batched lookup. */
export async function metadataIdsOf(rows: readonly DownloadRecord[]): Promise<Map<string, string>> {
	const identities = await downloadsStorage().findMediaIdentities([...new Set(rows.map((row) => row.mediaFileId))]);

	return toMap(
		identities,
		(identity) => identity.id,
		(identity) => identity.metadataId,
	);
}

/** The view of one row, with the title its media file belongs to. */
export async function viewOf(row: DownloadRecord): Promise<DownloadJobView> {
	const [identity] = await downloadsStorage().findMediaIdentities([row.mediaFileId]);

	return toView(row, identity?.metadataId ?? null);
}

export function toView(row: DownloadRecord, metadataId: string | null): DownloadJobView {
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
