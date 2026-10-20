import { serverConfig } from "@/config/server/server.config";
import { downloadsStorage } from "@/modules/downloads/downloads.ports";
import { type DirectoryEntry, readDirectoryEntries, removeTree } from "@/utils/directory.utils";

import { errorMessage, isMissingFile } from "@/utils/domain.errors";
import { joinPath } from "@/utils/path.utils";
import { deleteArtifactFile } from "./artifacts/artifacts.service";
import type { DownloadsServiceState } from "./shared.utils";

/** Retry sweep cadence — first pass shortly after boot, then daily. */
const RETENTION_SWEEP_FIRST_DELAY_MS = 60_000;
const RETENTION_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Expired rows are fetched in pages of this size; a shorter page is the last one. */
const EXPIRED_SWEEP_PAGE_SIZE = 500;
/** Artifact directories are named after their download id, a UUID; anything else under the root is left alone. */
const DOWNLOAD_ID_DIRECTORY_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORPHAN_SWEEP_BATCH_SIZE = 500;

export interface RetentionTimers {
	first: Timer;
	interval: Timer;
}

export function startRetentionTimers(sweep: () => void): RetentionTimers {
	const first = setTimeout(sweep, RETENTION_SWEEP_FIRST_DELAY_MS);
	const interval = setInterval(sweep, RETENTION_SWEEP_INTERVAL_MS);
	first.unref();
	interval.unref();

	return { first, interval };
}

/** Stops the retention sweeps so none of them touches the database after shutdown has closed it. */
export function stopRetentionTimers(timers: RetentionTimers): void {
	clearTimeout(timers.first);
	clearInterval(timers.interval);
}

/** Deletes completed/failed/cancelled downloads older than the retention window. */
export async function sweepExpired(state: DownloadsServiceState): Promise<{ removed: number }> {
	const retentionDays = serverConfig.downloads.retentionDays;
	if (retentionDays <= 0) return { removed: 0 };

	let removed = 0;
	// Loop until a short page comes back — retention may span thousands of rows.
	for (;;) {
		const expired = await downloadsStorage().findExpired(retentionDays);
		if (expired.length === 0) break;

		let progressed = false;
		for (const row of expired) {
			// One EBUSY/EACCES must not abort the whole sweep (the old code threw
			// and the loop never advanced).
			try {
				await deleteArtifactFile(row);
				await downloadsStorage().delete(row.id);
				removed++;
				progressed = true;
			} catch (error) {
				state.logger.warn("Retention sweep failed for a download", { downloadId: row.id, error: errorMessage(error) });
			}
		}

		// No row could be removed → stop instead of re-fetching the same page forever.
		if (!progressed || expired.length < EXPIRED_SWEEP_PAGE_SIZE) break;
	}

	if (removed > 0) state.logger.info("Retention sweep removed downloads", { removed });

	return { removed };
}

/**
 * Removes artifact directories whose download row is gone. A row is written before
 * its directory exists, so a directory without a row belongs to a row deleted
 * without its file, typically after a crash between the two steps.
 */
export async function sweepOrphanArtifacts(state: DownloadsServiceState): Promise<{ removed: number }> {
	const root = serverConfig.paths.downloads;
	let entries: DirectoryEntry[];
	try {
		entries = await readDirectoryEntries(root);
	} catch (error) {
		if (isMissingFile(error)) return { removed: 0 };

		throw error;
	}
	const candidates = entries
		.filter((entry) => entry.isDirectory && DOWNLOAD_ID_DIRECTORY_REGEX.test(entry.name))
		.map((entry) => entry.name);

	let removed = 0;
	for (let offset = 0; offset < candidates.length; offset += ORPHAN_SWEEP_BATCH_SIZE) {
		const batch = candidates.slice(offset, offset + ORPHAN_SWEEP_BATCH_SIZE);
		const known = await downloadsStorage().findExistingIds(batch);
		for (const id of batch) {
			if (known.has(id)) continue;

			try {
				await removeTree(joinPath(root, id));
				removed++;
			} catch (error) {
				state.logger.warn("Could not remove the artifacts of a deleted download", { downloadId: id, error: errorMessage(error) });
			}
		}
	}

	if (removed > 0) state.logger.info("Removed artifacts of deleted downloads", { removed });

	return { removed };
}
