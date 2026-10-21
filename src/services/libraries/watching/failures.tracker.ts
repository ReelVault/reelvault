import { serverConfig } from "@/config/server/server.config";
import { serverRescueService } from "@/system/server-rescue.service";
import type { LibraryWatcherState, WatcherFailureEntry, WatcherFailureInfo } from "./state.types";
import { armTimer, RESCUE_RECHECK_MS } from "./timing.utils";

const WATCHER_FAILURE_NOTIFICATION_TYPE = "library_watcher_unavailable";

/**
 * Best-effort admin notification for an unwatchable path. Dynamic imports keep
 * the notifications/repository graph out of this service's module cycle.
 */
export async function notifyAdminsOfWatcherFailure(failure: WatcherFailureInfo): Promise<void> {
	const { notificationsService } = await import("@/services/notifications/notifications.service");
	const fallbackMinutes = serverConfig.scanning.watcherFallbackIntervalMinutes;
	const message =
		fallbackMinutes > 0
			? `ReelVault could not watch this library path (${failure.reason}). It will be rescanned automatically every ${fallbackMinutes} minutes until it recovers.`
			: `ReelVault could not watch this library path (${failure.reason}). New files may not appear until a scan runs.`;
	await notificationsService.createForAdministrators(
		{
			type: WATCHER_FAILURE_NOTIFICATION_TYPE,
			title: `Real-time watching unavailable for ${failure.path}`,
			message,
			data: { libraryId: failure.libraryId, pathId: failure.pathId, path: failure.path, reason: failure.reason },
			link: "/admin/libraries",
		},
		{ skipOwnershipCheck: true },
	);
}

/** Records a path the watcher cannot cover and notifies admins once per episode. */
export async function recordFailure(
	state: LibraryWatcherState,
	libraryId: string,
	pathId: string,
	path: string,
	reason: string,
): Promise<void> {
	const existing = state.failures.get(pathId);
	if (existing) {
		// Keep the latest reason but never re-notify within one failure episode.
		existing.reason = reason;

		return;
	}

	const entry: WatcherFailureEntry = {
		libraryId,
		pathId,
		path,
		reason,
		since: state.clock.now(),
		notified: false,
		fallbackTimer: null,
	};
	state.failures.set(pathId, entry);
	state.logger.error("Real-time watching unavailable for library path", { libraryId, pathId, path, reason });
	armFallback(state, entry);

	entry.notified = true;
	try {
		await state.notifyFailure({ libraryId, pathId, path, reason, since: entry.since });
	} catch (error) {
		state.logger.warn("Failed to notify administrators about an unwatchable library path", { libraryId, pathId, error });
	}
}

/** Schedules the next periodic fallback scan for an unwatchable path (0 = disabled). */
function armFallback(state: LibraryWatcherState, entry: WatcherFailureEntry): void {
	const intervalMinutes = serverConfig.scanning.watcherFallbackIntervalMinutes;
	if (intervalMinutes <= 0) return;

	entry.fallbackTimer = armTimer(state.clock, () => runFallback(state, entry.pathId), intervalMinutes * 60_000);
}

/**
 * Rescans a path whose watcher is unavailable, then re-arms. Never throws:
 * the timer callback owns the promise, and a failing scan must not kill the
 * schedule (the reconcile loop clears the failure on recovery).
 */
async function runFallback(state: LibraryWatcherState, pathId: string): Promise<void> {
	try {
		const entry = state.failures.get(pathId);
		if (!entry) return;

		if (state.isShuttingDown || !serverConfig.scanning.autoWatcherEnabled) return;

		// Server rescue pauses background work — re-check soon instead of scanning.
		if (serverRescueService.isThrottling()) {
			entry.fallbackTimer = armTimer(state.clock, () => runFallback(state, pathId), RESCUE_RECHECK_MS);

			return;
		}

		state.logger.info("Running fallback scan for a path without a real-time watcher", {
			libraryId: entry.libraryId,
			pathId,
			path: entry.path,
		});

		try {
			await state.scanPathFn?.(entry.libraryId, pathId);
		} catch (error) {
			state.logger.error("Fallback scan for an unwatchable library path failed", error, { libraryId: entry.libraryId, pathId });
		}

		armFallback(state, entry);
	} catch (error) {
		state.logger.error("Fallback scan scheduling failed", error, { pathId });
	}
}

/** Drops the failure state for a path (watcher recovered or path removed). */
export function clearFailure(state: LibraryWatcherState, pathId: string): void {
	const entry = state.failures.get(pathId);
	if (!entry) return;

	if (entry.fallbackTimer !== null) state.clock.clearTimeout(entry.fallbackTimer);
	state.failures.delete(pathId);
}

/** Paths the filesystem watcher currently cannot cover. */
export function getUnwatchablePaths(state: LibraryWatcherState): WatcherFailureInfo[] {
	return [...state.failures.values()].map(({ libraryId, pathId, path, reason, since }) => ({ libraryId, pathId, path, reason, since }));
}
