import type { BulkRefreshItem } from "@reelvault/sdk/common";
import { serverConfig } from "@/config/server/server.config";
import { DEFAULT_DOWNLOAD_QUALITY, isDownloadQuality } from "@/modules/downloads/download-quality.utils";
import { downloadsProcess, downloadsStorage } from "@/modules/downloads/downloads.ports";
import { assertFound, assertProfileId, DomainError, errorCodeOf, errorMessage } from "@/utils/domain.errors";
import { runSafely } from "@/utils/safe-execute.utils";
import { type DownloadsServiceState, getStorageQuota, type WithoutState } from "./shared.utils";
import { type DownloadJobView, viewOf } from "./views/views.mapper";

/** Most downloads one profile may have waiting for a running slot; a request beyond it is refused. */
const MAX_QUEUED_DOWNLOADS_PER_PROFILE = 200;

interface SeasonFileCandidate {
	mediaFileId: string;
	isDefault: boolean;
	sizeBytes: number;
}

export type PrepareOne = (...args: WithoutState<typeof prepare>) => ReturnType<typeof prepare>;

/** The default file of an episode wins; otherwise the first file seen is kept. */
function preferDefaultFile(current: SeasonFileCandidate | null, candidate: SeasonFileCandidate | null): SeasonFileCandidate | null {
	if (!current) return candidate;
	if (candidate?.isDefault && !current.isDefault) return candidate;

	return current;
}

/** Refuses the call before any work: downloads must be enabled and the caller must have a profile. */
function assertDownloadsAvailable(profileId: string | undefined): asserts profileId is string {
	assertProfileId(profileId);
	if (!serverConfig.downloads.enabled)
		throw new DomainError("forbidden", "Downloads are disabled on this server", { code: "downloads.disabled" });
}

export async function prepare(
	state: DownloadsServiceState,
	profileId: string | undefined,
	mediaFileId: string,
	quality: string = DEFAULT_DOWNLOAD_QUALITY,
): Promise<DownloadJobView> {
	return await runSafely(state, "prepare", async () => {
		assertDownloadsAvailable(profileId);

		if (!mediaFileId.trim()) throw new DomainError("validation", "mediaFileId is required", { code: "downloads.media_file_required" });

		const mediaFile = await downloadsStorage().findMediaFileForDownload(mediaFileId);
		assertFound(mediaFile, "MediaFile", mediaFileId);
		if (quality !== "original" && !(mediaFile.duration && mediaFile.duration > 0)) {
			throw new DomainError("validation", "Transcoded download requires a known file duration", { code: "downloads.duration_unknown" });
		}

		if (await downloadsStorage().hasActiveByProfileAndMedia(profileId, mediaFileId)) {
			throw new DomainError("conflict", "This title is already downloading for this profile", { code: "downloads.in_progress" });
		}

		if ((await downloadsStorage().countPendingByProfile(profileId)) >= MAX_QUEUED_DOWNLOADS_PER_PROFILE) {
			throw new DomainError("conflict", "This profile already has too many downloads waiting", { code: "downloads.queue_full" });
		}

		const { maxBytes, usedBytes } = await getStorageQuota(profileId);
		if (maxBytes > 0 && usedBytes >= maxBytes) {
			throw new DomainError("conflict", "Storage quota exceeded — delete older downloads first", {
				code: "downloads.quota_exceeded",
				params: { maxBytes, usedBytes },
			});
		}

		const row = await downloadsStorage().insert({
			profileId,
			mediaFileId,
			quality: isDownloadQuality(quality) ? quality : DEFAULT_DOWNLOAD_QUALITY,
		});
		await promoteQueued(state, profileId);

		return await viewOf(row);
	});
}

/**
 * Queues every episode of a season with its default media file (or its first one). A season whose estimated size
 * does not fit the free storage is refused unless `force` is set. Each episode reports its own outcome.
 */
export async function queueSeason(
	state: DownloadsServiceState,
	profileId: string | undefined,
	body: { seasonId: string; quality?: string | undefined; force?: boolean | undefined },
	assertAccess: (mediaFileId: string) => Promise<void>,
	prepareOne: PrepareOne,
): Promise<{ results: BulkRefreshItem[] }> {
	return await runSafely(state, "queueSeason", async () => {
		assertDownloadsAvailable(profileId);

		const season = await downloadsStorage().findSeasonForDownload(body.seasonId);
		assertFound(season, "Season", body.seasonId);

		const episodeFiles = new Map<string, SeasonFileCandidate | null>();
		for (const row of await downloadsStorage().findEpisodeFilesByMetadataId(season.metadataId)) {
			if (row.seasonId !== season.id) continue;
			const candidate = row.mediaFileId
				? { mediaFileId: row.mediaFileId, isDefault: row.mediaFileIsDefault === true, sizeBytes: row.mediaFileSize ?? 0 }
				: null;
			episodeFiles.set(row.id, preferDefaultFile(episodeFiles.get(row.id) ?? null, candidate));
		}

		const estimatedBytes = [...episodeFiles.values()].reduce((sum, chosen) => sum + (chosen?.sizeBytes ?? 0), 0);
		const { maxBytes, usedBytes } = await getStorageQuota(profileId);
		const freeBytes = Math.max(0, maxBytes - usedBytes);
		if (maxBytes > 0 && estimatedBytes > freeBytes && !body.force) {
			throw new DomainError("conflict", "This season is larger than the free download space", {
				code: "downloads.season_exceeds_quota",
				params: { estimatedBytes, freeBytes },
			});
		}

		const results: BulkRefreshItem[] = [];
		for (const [episodeId, chosen] of episodeFiles) {
			if (!chosen) {
				results.push({ id: episodeId, ok: false, code: "downloads.no_media_file" });
				continue;
			}

			try {
				await assertAccess(chosen.mediaFileId);
				await prepareOne(profileId, chosen.mediaFileId, body.quality);
				results.push({ id: episodeId, ok: true });
			} catch (error) {
				results.push({ id: episodeId, ok: false, code: errorCodeOf(error, "downloads.queue_failed") });
			}
		}

		return { results };
	});
}

/**
 * Enqueues the profile's oldest waiting downloads, as many as it has free running slots. The worker claims a slot
 * when it runs, so a download that is enqueued twice is harmless. Never rejects: a failure is only logged.
 */
export async function promoteQueued(state: DownloadsServiceState, profileId: string): Promise<void> {
	try {
		const freeSlots = serverConfig.downloads.maxConcurrentPerProfile - (await downloadsStorage().countProcessingByProfile(profileId));
		if (freeSlots <= 0) return;

		for (const row of await downloadsStorage().findPendingByProfile(profileId, freeSlots)) {
			await downloadsProcess().enqueueProcess(row.id);
		}
	} catch (error) {
		state.logger.warn("Could not start the queued downloads", { profileId, error: errorMessage(error) });
	}
}
