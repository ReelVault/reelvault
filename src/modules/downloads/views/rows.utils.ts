import { type DownloadRecord, downloadsStorage } from "@/modules/downloads/downloads.ports";
import { DomainError } from "@/utils/domain.errors";

function downloadNotFound(): DomainError {
	return new DomainError("not_found", "Download not found", { code: "download_not_found" });
}

export async function requireDownload(downloadId: string): Promise<DownloadRecord> {
	const row = await downloadsStorage().findById(downloadId);
	if (!row) throw downloadNotFound();

	return row;
}

/** The download when it belongs to the profile; another profile's id reads as absent, so ids leak nothing. */
export async function getOwnedDownload(jobId: string, profileId: string): Promise<DownloadRecord | null> {
	const row = await downloadsStorage().findById(jobId);
	if (!row || row.profileId !== profileId) return null;

	return row;
}

export async function assertOwnedDownload(jobId: string, profileId: string): Promise<DownloadRecord> {
	const row = await getOwnedDownload(jobId, profileId);
	if (!row) throw downloadNotFound();

	return row;
}
