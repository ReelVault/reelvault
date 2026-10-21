import { type FSWatcher, watch } from "node:fs";
import { resolve } from "node:path";
import { serverConfig } from "@/config/server/server.config";
import { librariesRepository } from "@/repositories/libraries.repository";
import { toMap } from "@/utils/array.utils";
import { directoryExists } from "@/utils/directory.utils";
import { errorMessage } from "@/utils/domain.errors";
import { detach } from "@/utils/promise.utils";
import { runSafely } from "@/utils/safe-execute.utils";
import { handleFsEvent } from "./debounce.watcher";
import { clearFailure, recordFailure } from "./failures.tracker";
import type { LibraryWatcherState } from "./state.types";

/**
 * Drops the debounce timers and cooldowns of one library path. Keys are `${libraryId}:${pathId}`.
 * A cooldown is dropped even when its pending scan already fired, so no timestamp outlives its path.
 */
function forgetPathScanState(state: LibraryWatcherState, pathId: string): void {
	const suffix = `:${pathId}`;
	for (const [key, pending] of state.pendingScans.entries()) {
		if (key.endsWith(suffix)) {
			state.clock.clearTimeout(pending.timer);
			state.pendingScans.delete(key);
		}
	}

	for (const key of state.cooldowns.keys()) {
		if (key.endsWith(suffix)) state.cooldowns.delete(key);
	}
}

export function stopWatcher(state: LibraryWatcherState, pathId: string): void {
	const entry = state.watchers.get(pathId);
	if (entry) {
		try {
			entry.watcher.close();
		} catch {
			// intentionally empty
		}

		state.watchers.delete(pathId);
		state.logger.debug("Stopped real-time watcher for library path", { pathId, path: entry.path });
	}

	forgetPathScanState(state, pathId);
	clearFailure(state, pathId);
}

export function stopAllWatchers(state: LibraryWatcherState): void {
	for (const entry of state.watchers.values()) {
		try {
			entry.watcher.close();
		} catch {
			// intentionally empty
		}
	}

	state.watchers.clear();

	for (const pending of state.pendingScans.values()) {
		state.clock.clearTimeout(pending.timer);
	}

	state.pendingScans.clear();
	state.cooldowns.clear();

	for (const entry of state.failures.values()) {
		if (entry.fallbackTimer !== null) state.clock.clearTimeout(entry.fallbackTimer);
	}

	state.failures.clear();
}

/**
 * Brings the watchers in line with the active library paths: stops the ones that were removed or repointed,
 * drops their failures, and starts a watcher for each new path. Calls are serialised.
 */
export async function syncWatchers(state: LibraryWatcherState): Promise<void> {
	// Serialize: concurrent syncs from create/update/delete + the reconcile timer
	// could both pass the `!watchers.has(pathId)` check and leak a watcher.
	if (state.isShuttingDown || state.isSyncing) return;

	state.isSyncing = true;
	try {
		if (!serverConfig.scanning.autoWatcherEnabled) {
			stopAllWatchers(state);
			state.logger.debug("Real-time auto watcher is disabled in server settings");

			return;
		}

		await runSafely(state, "syncWatchers", async () => {
			const activePaths = await librariesRepository.findActiveLibraryPaths();
			const activePathById = toMap(activePaths, (p) => p.id);
			const isCurrent = (pathId: string, recordedPath: string) => {
				const current = activePathById.get(pathId);

				return current !== undefined && resolve(current.path) === recordedPath;
			};

			// Remove watchers for paths that are no longer active or deleted; failures of removed/repointed paths go too.
			for (const [pathId, entry] of state.watchers.entries()) {
				if (!isCurrent(pathId, entry.path)) stopWatcher(state, pathId);
			}

			for (const [pathId, failure] of state.failures.entries()) {
				if (!isCurrent(pathId, failure.path)) clearFailure(state, pathId);
			}

			// Add watchers for newly active paths
			for (const pathRecord of activePaths) {
				if (!state.watchers.has(pathRecord.id)) {
					await startWatcher(state, pathRecord.libraryId, pathRecord.id, pathRecord.path);
				}
			}

			state.logger.debug("Library watchers synchronized", { activeWatchers: state.watchers.size, unwatchablePaths: state.failures.size });
		});
	} catch {
		// Failures in watcher synchronization are logged by safeExecute and non-fatal for caller
	} finally {
		state.isSyncing = false;
	}
}

async function startWatcher(state: LibraryWatcherState, libraryId: string, pathId: string, rawPath: string): Promise<void> {
	const resolvedPath = resolve(rawPath);

	try {
		const exists = await directoryExists(resolvedPath);
		if (!exists) {
			await recordFailure(state, libraryId, pathId, resolvedPath, "path_missing");
			state.logger.debug("Library path does not exist on disk, skipping real-time watcher", {
				libraryId,
				pathId,
				path: resolvedPath,
			});

			return;
		}

		const target = { libraryId, pathId, rootPath: resolvedPath };
		const watcher: FSWatcher = watch(resolvedPath, { recursive: true }, (eventType, filename) => {
			handleFsEvent(state, target, eventType, filename);
		});

		watcher.on("error", (error) => {
			state.logger.warn("Filesystem watcher encountered an error", {
				libraryId,
				pathId,
				path: resolvedPath,
				error,
			});
			stopWatcher(state, pathId);
			detach(recordFailure(state, libraryId, pathId, resolvedPath, `watcher_error: ${errorMessage(error)}`));
		});

		state.watchers.set(pathId, {
			libraryId,
			pathId,
			path: resolvedPath,
			watcher,
		});
		clearFailure(state, pathId);

		state.logger.info("Started real-time file watcher for library path", {
			libraryId,
			pathId,
			path: resolvedPath,
		});
	} catch (error) {
		await recordFailure(state, libraryId, pathId, resolvedPath, `watch_failed: ${errorMessage(error)}`);
		state.logger.warn("Could not start real-time watcher for library path", {
			libraryId,
			pathId,
			path: resolvedPath,
			error,
		});
	}
}
