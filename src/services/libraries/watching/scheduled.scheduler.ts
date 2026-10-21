import { serverConfig } from "@/config/server/server.config";
import { HOUR } from "@/config/server/server.constants";
import { librariesRepository } from "@/repositories/libraries.repository";
import { workerOperationRepository } from "@/repositories/worker-operation.repository";
import { serverRescueService } from "@/system/server-rescue.service";
import type { LibraryWatcherState } from "./state.types";

/**
 * Fires the periodic library rescan when `scanning.scheduledScanIntervalHours`
 * is due. Network mounts can miss filesystem events WITHOUT raising a watcher
 * error — the per-path fallback is never armed in that case, so this interval
 * is the belt-and-braces rescan. Due-ness comes from the persisted
 * library-scan operations (survives restarts; a manual/watcher scan counts as
 * a recent scan). Never throws: it runs from a detached reconcile tick.
 */
export async function runScheduledScanIfDue(state: LibraryWatcherState): Promise<void> {
	try {
		await runScheduledScan(state);
	} catch (error) {
		// Runs from a detached reconcile tick — a DB error must neither surface as
		// an unhandled rejection nor kill the loop for later ticks.
		state.logger.warn("Periodic library rescan check failed", { error });
	}
}

async function runScheduledScan(state: LibraryWatcherState): Promise<void> {
	if (state.isShuttingDown) return;

	const intervalHours = serverConfig.scanning.scheduledScanIntervalHours;
	if (intervalHours <= 0) return;

	// Rescue pauses background work — keep the deadline due and retry next tick.
	if (serverRescueService.isThrottling()) return;

	const activePaths = await librariesRepository.findActiveLibraryPaths();
	const libraryIds = [...new Set(activePaths.map((entry) => entry.libraryId))];
	if (libraryIds.length === 0) return;

	const cutoff = new Date(state.clock.now() - intervalHours * HOUR);
	const latestScanTimes = await workerOperationRepository.findLatestLibraryScanTimes(libraryIds);
	const dueLibraryIds = libraryIds.filter((libraryId) => {
		const lastScanAt = latestScanTimes.get(libraryId);

		return !lastScanAt || lastScanAt.getTime() <= cutoff.getTime();
	});
	if (dueLibraryIds.length === 0) return;

	state.logger.info("Running periodic library rescan", { libraries: dueLibraryIds.length, intervalHours });

	for (const libraryId of dueLibraryIds) {
		try {
			await state.scanLibraryFn?.(libraryId);
		} catch (error) {
			state.logger.error("Periodic library rescan failed to enqueue", error, { libraryId });
		}
	}
}
