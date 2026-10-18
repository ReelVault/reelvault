import type { DownloadStatus } from "@/integrations/drizzle-orm/constants/downloads.constants";
import { QueryPagination } from "@/integrations/drizzle-orm/query/pagination.utils";
import { downloadsStorage } from "@/modules/downloads/downloads.ports";
import { resolveFileFromRow } from "../artifacts/artifacts.service";
import { getStorageQuota } from "../shared.utils";
import { assertOwnedDownload, getOwnedDownload } from "./rows.utils";
import { type DownloadJobView, metadataIdsOf, toView, viewOf } from "./views.mapper";

export interface DownloadsPageQuery {
	page?: number | undefined;
	limit?: number | undefined;
	status?: DownloadStatus | undefined;
}

export async function list(profileId: string): Promise<{ data: DownloadJobView[]; quota: { usedBytes: number; maxBytes: number } }> {
	const [rows, quota] = await Promise.all([downloadsStorage().findByProfile(profileId), getStorageQuota(profileId)]);

	const metadataIds = await metadataIdsOf(rows);

	return { data: rows.map((row) => toView(row, metadataIds.get(row.mediaFileId) ?? null)), quota };
}

/** One page of every profile's downloads for the admin overview, with the counts per status for its counters. */
export async function listAllPage(query: DownloadsPageQuery) {
	const pagination = QueryPagination.resolvePageParams(query, { defaultLimit: 50 });
	const [result, counts] = await Promise.all([
		downloadsStorage().findPage({ status: query.status, limit: pagination.limit, offset: pagination.offset }),
		downloadsStorage().countByStatus(),
	]);
	const metadataIds = await metadataIdsOf(result.data);

	return {
		...QueryPagination.createResponse({
			total: result.total,
			pagination,
			data: result.data.map((row) => ({
				...toView(row, metadataIds.get(row.mediaFileId) ?? null),
				profileId: row.profileId,
			})),
		}),
		counts,
	};
}

/** Ownership-checked variants — a profile only ever sees its own jobs. */
export async function getJobViewForProfile(jobId: string, profileId: string): Promise<DownloadJobView | null> {
	const row = await getOwnedDownload(jobId, profileId);

	return row ? await viewOf(row) : null;
}

/** Media file of an owned download; the route checks stream access against it before a retry. */
export async function mediaFileIdForProfile(jobId: string, profileId: string): Promise<string> {
	return (await assertOwnedDownload(jobId, profileId)).mediaFileId;
}

export async function resolveFileForProfile(jobId: string, profileId: string): Promise<{ fileName: string; blob: Blob } | null> {
	return await resolveFileFromRow(await getOwnedDownload(jobId, profileId));
}

/** Completed download as a file handle, for a caller that is not scoped to a profile. */
export async function resolveFile(downloadId: string): Promise<{ fileName: string; blob: Blob } | null> {
	return await resolveFileFromRow(await downloadsStorage().findById(downloadId));
}
