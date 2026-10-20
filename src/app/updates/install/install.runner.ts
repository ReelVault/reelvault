import type { AdminUpdateRelease } from "@reelvault/sdk/common";
import { adminFailureNotificationService } from "@/app/admin/admin-failure-notification.service";
import { databaseBackupService } from "@/app/admin/database-backup.service";
import { databaseMaintenanceService } from "@/app/admin/database-maintenance.service";
import { PENDING_DIR, STAGING_DIR, type UpdateComponent } from "@/app/updates/update-environment.utils";
import { updateHistoryService } from "@/app/updates/update-history.service";
import { checksumForFile, serverAssetName, webAssetName } from "@/app/updates/update-release.utils";
import { downloadArchive } from "@/plugins/catalog/plugin-package/download.fetcher";
import { MIB } from "@/utils/bytes.utils";
import { assertChecksumMatches } from "@/utils/crypto.utils";
import { DomainError, errorCodeOf } from "@/utils/domain.errors";
import { guardedFetch } from "@/utils/url-guard.utils";
import { applyServerUpdate, applyWebUpdate } from "./apply.service";
import { assertNotCancelled, removeScratchDirectories, setJob, setLastError, type UpdateInstallState } from "./shared.types";

/** Release archives reach ~250 MB compressed (~1 GB uncompressed with ffmpeg). */
const MAX_ARCHIVE_BYTES = 1024 * MIB;
/** A slow line downloading the archive needs far more than the plugin default. */
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;

/**
 * Runs one install from download to swap. A cancelled run leaves the running version alone; any other failure
 * is recorded against the component and its scratch files are removed. Never rejects into the detached caller.
 */
export async function runInstall(
	state: UpdateInstallState,
	target: UpdateComponent,
	release: AdminUpdateRelease,
	historyId: string | null,
): Promise<void> {
	try {
		const assetName =
			target === "server" ? serverAssetName(process.platform, process.arch, release.version) : webAssetName(release.version);
		const asset = release.assets.find((item) => item.name === assetName);
		if (!asset) {
			throw new DomainError("validation", `Release ${release.version} has no archive for this component (${assetName})`, {
				code: "update.asset_missing",
			});
		}
		const sumsAsset = release.assets.find((item) => item.name === "SHA256SUMS.txt");
		if (!sumsAsset) {
			throw new DomainError("validation", "Release assets are missing SHA256SUMS.txt", { code: "update.checksums_missing" });
		}

		setJob(state, "downloading", 10, assetName);
		const download = await downloadArchive(asset.url, {
			maxBytes: MAX_ARCHIVE_BYTES,
			timeoutMs: DOWNLOAD_TIMEOUT_MS,
			signal: state.cancelController?.signal,
			fetcher: state.archiveFetcher,
			onProgress: (received, total) => {
				const percent = total > 0 ? 5 + Math.min(55, Math.round((received / total) * 55)) : 10;
				setJob(state, "downloading", percent, assetName);
			},
		});

		try {
			setJob(state, "verifying", 65, "SHA256SUMS.txt");
			const expected = checksumForFile(await fetchText(state, sumsAsset.url), assetName);
			if (!expected) {
				throw new DomainError("validation", `SHA256SUMS.txt has no entry for ${assetName}`, { code: "update.checksum_mismatch" });
			}
			assertChecksumMatches(download.checksum, expected, {
				checksum: true,
				code: "update.checksum_mismatch",
				message: "Downloaded release archive failed the SHA256 verification",
			});
			assertNotCancelled(state);

			if (target === "web") {
				await applyWebUpdate(state, download.filePath, release.version);
				await updateHistoryService.succeed(historyId);
			} else {
				const note = await preUpdateCheck(state);
				await applyServerUpdate(state, download.filePath, release.version);
				// The swap has set the restart state; the note stays on the job until the restarted server takes over.
				setJob(state, "restarting", 97, note);
			}
		} finally {
			await download.cleanup();
		}
	} catch (error) {
		if (state.cancelController?.signal.aborted) {
			await finishCancelledInstall(state, target, historyId);

			return;
		}

		const errorCode = errorCodeOf(error, "update.install_failed");
		setLastError(state, target, errorCode);
		state.job = null;
		state.logger.error(`Update install for ${target} failed`, error);
		// staging cleanup must never mask the original failure
		removeScratchDirectories(state, [STAGING_DIR, PENDING_DIR]);
		adminFailureNotificationService.notifyUpdateFailed(target, release.version);
		await updateHistoryService.fail(historyId, errorCode);
	}
}

/** A cancelled install leaves the running version alone, removes its scratch files and records no failure. */
async function finishCancelledInstall(state: UpdateInstallState, target: UpdateComponent, historyId: string | null): Promise<void> {
	state.logger.info(`Update install for ${target} cancelled`);
	state.job = null;
	removeScratchDirectories(state, [STAGING_DIR, PENDING_DIR]);
	await updateHistoryService.cancel(historyId);
}

/**
 * Copies the database and runs SQLite's quick check on the copy before any file is replaced.
 * A failed check stops the update here, so a damaged database is never upgraded. The returned
 * note names the copy and stays on the job until the restarted server takes over.
 */
async function preUpdateCheck(state: UpdateInstallState): Promise<string> {
	setJob(state, "verifying", 70, "database backup");
	const backup = await databaseBackupService.createBackup();
	const integrity = await databaseMaintenanceService.checkIntegrity();
	if (!integrity.ok) {
		throw new DomainError("validation", "The database failed its integrity check, so the update was not installed", {
			code: "update.database_integrity_failed",
			params: { backup: backup.fileName },
		});
	}

	return `database backup ${backup.fileName}, integrity check passed`;
}

async function fetchText(state: UpdateInstallState, url: string): Promise<string> {
	const fetcher = state.archiveFetcher ?? guardedFetch;
	const response = await fetcher(url, { signal: AbortSignal.timeout(60_000) });
	if (!response.ok)
		throw new DomainError("validation", `Checksum listing download failed with HTTP ${response.status}`, {
			code: "update.checksums_missing",
		});

	return await response.text();
}
