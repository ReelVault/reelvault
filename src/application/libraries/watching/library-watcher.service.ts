import { type FSWatcher, watch } from "node:fs";
import { librariesRepository } from "@/database/repositories/libraries.repository";
import { workerOperationRepository } from "@/database/repositories/worker-operation.repository";
import { isIgnoredRelativePath } from "@/modules/scanner/disk/file-scanner";
import { serverConfig } from "@/server.config";
import { HOUR } from "@/server.constants";
import { serverRescueService } from "@/system/server-rescue.service";
import { toMap } from "@/utils/array.utils";
import { BaseService } from "@/utils/base-service";
import { DirUtils } from "@/utils/directory.utils";
import { errorMessage } from "@/utils/errors";
import { PathUtils } from "@/utils/path.utils";
import { detach } from "@/utils/promise.utils";

interface WatchedPathEntry {
	libraryId: string;
	pathId: string;
	path: string;
	watcher: FSWatcher;
}

interface PendingScanState {
	timer: unknown;
}

/** A library path the filesystem watcher cannot cover; surfaced to admins once per episode. */
export interface WatcherFailureInfo {
	libraryId: string;
	pathId: string;
	path: string;
	reason: string;
	since: number;
}

interface WatcherFailureEntry extends WatcherFailureInfo {
	notified: boolean;
	fallbackTimer: unknown;
}

const WATCHER_FAILURE_NOTIFICATION_TYPE = "library_watcher_unavailable";

/**
 * Best-effort admin notification for an unwatchable path. Dynamic imports keep
 * the notifications/repository graph out of this service's module cycle.
 */
async function notifyAdminsOfWatcherFailure(failure: WatcherFailureInfo): Promise<void> {
	const [{ notificationsService }, { usersRepository }] = await Promise.all([
		import("@/application/notifications/notifications.service"),
		import("@/database/repositories/users.repository"),
	]);
	const admins = await usersRepository.findAllAdministrators();
	const fallbackMinutes = serverConfig.scanning.watcherFallbackIntervalMinutes;
	const message =
		fallbackMinutes > 0
			? `ReelVault could not watch this library path (${failure.reason}). It will be rescanned automatically every ${fallbackMinutes} minutes until it recovers.`
			: `ReelVault could not watch this library path (${failure.reason}). New files may not appear until a scan runs.`;
	for (const admin of admins) {
		await notificationsService.create(
			{
				userId: admin.id,
				type: WATCHER_FAILURE_NOTIFICATION_TYPE,
				title: `Real-time watching unavailable for ${failure.path}`,
				message,
				data: { libraryId: failure.libraryId, pathId: failure.pathId, path: failure.path, reason: failure.reason },
				link: "/admin/libraries",
			},
			{ skipOwnershipCheck: true },
		);
	}
}

/** Time source for the debounce/cooldown state machine. Tests inject a manual
 * clock; production uses real timers + wall clock. */
export interface LibraryWatcherClock<TTimer = unknown> {
	setTimeout(callback: () => unknown, ms: number): TTimer;
	clearTimeout(timer: TTimer): void;
	now(): number;
	/** Best-effort timer unref; optional so manual test clocks can omit it. */
	unrefTimer?(timer: TTimer): void;
}

const defaultClock: LibraryWatcherClock<Timer> = {
	setTimeout: (callback, ms) => setTimeout(callback, ms),
	clearTimeout: (timer) => clearTimeout(timer),
	now: () => Date.now(),
	unrefTimer: (timer) => timer.unref(),
};

/** While the server rescue system is throttling, re-check this often instead of scanning. */
const RESCUE_RECHECK_MS = 5_000;
/** Periodic reconcile: re-arm watchers lost to a missing mount or an fs error. */
const WATCHER_RECONCILE_INTERVAL_MS = 60_000;

export class LibraryWatcherService extends BaseService {
	private readonly watchers = new Map<string, WatchedPathEntry>();
	/** `${libraryId}:${pathId}` → debounce timer waiting to fire a scan. */
	private readonly pendingScans = new Map<string, PendingScanState>();
	/** `${libraryId}:${pathId}` → earliest moment the next watcher-triggered scan may fire. */
	private readonly cooldowns = new Map<string, number>();
	/** pathId → a path the filesystem watcher cannot cover. */
	private readonly failures = new Map<string, WatcherFailureEntry>();

	private readonly clock: LibraryWatcherClock;
	private readonly notifyFailure: (failure: WatcherFailureInfo) => Promise<void>;
	private isInitialized = false;
	private isShuttingDown = false;
	private isSyncing = false;
	private reconcileTimer: ReturnType<typeof setInterval> | null = null;
	/**
	 * Scan trigger registered by `librariesService` at construction. Avoids a
	 * direct import back into `libraries.service` (import cycle).
	 */
	private scanPathFn?: ((libraryId: string, pathId: string) => Promise<unknown>) | undefined;
	/** Whole-library scan trigger used by the periodic rescan. */
	private scanLibraryFn?: ((libraryId: string) => Promise<unknown>) | undefined;

	constructor(
		clock: LibraryWatcherClock = defaultClock,
		notifyFailure: (failure: WatcherFailureInfo) => Promise<void> = notifyAdminsOfWatcherFailure,
	) {
		super("LibraryWatcherService");
		this.clock = clock;
		this.notifyFailure = notifyFailure;
	}

	registerScanner(fn: (libraryId: string, pathId: string) => Promise<unknown>): void {
		this.scanPathFn = fn;
	}

	/** Registers the whole-library scan used by `scanning.scheduledScanIntervalHours`. */
	registerLibraryScanner(fn: (libraryId: string) => Promise<unknown>): void {
		this.scanLibraryFn = fn;
	}

	async init(): Promise<void> {
		if (this.isInitialized) return;

		this.isInitialized = true;
		this.logger.info("Initializing library watcher service...");
		await this.syncWatchers();
		// Periodically reconcile so a watcher lost to a transient mount failure or
		// an fs error is re-armed without waiting for an admin to edit the library,
		// and fire the periodic whole-library rescan when due.
		if (!this.reconcileTimer) {
			this.reconcileTimer = setInterval(() => {
				detach(this.syncWatchers());
				detach(this.runScheduledScanIfDue());
			}, WATCHER_RECONCILE_INTERVAL_MS);
			this.reconcileTimer.unref();
		}
	}

	/**
	 * Fires the periodic library rescan when `scanning.scheduledScanIntervalHours`
	 * is due. Network mounts can miss filesystem events WITHOUT raising a watcher
	 * error — the per-path fallback is never armed in that case, so this interval
	 * is the belt-and-braces rescan. Due-ness comes from the persisted
	 * library-scan operations (survives restarts; a manual/watcher scan counts as
	 * a recent scan). Public so tests can drive it with a manual clock.
	 */
	async runScheduledScanIfDue(): Promise<void> {
		if (this.isShuttingDown) return;

		const intervalHours = serverConfig.scanning.scheduledScanIntervalHours;
		if (intervalHours <= 0) return;

		// Rescue pauses background work — keep the deadline due and retry next tick.
		if (serverRescueService.isThrottling()) return;

		const activePaths = await librariesRepository.findActiveLibraryPaths();
		const libraryIds = [...new Set(activePaths.map((entry) => entry.libraryId))];
		if (libraryIds.length === 0) return;

		const cutoff = new Date(this.clock.now() - intervalHours * HOUR);
		const latestScanTimes = await workerOperationRepository.findLatestLibraryScanTimes(libraryIds);
		const dueLibraryIds = libraryIds.filter((libraryId) => {
			const lastScanAt = latestScanTimes.get(libraryId);

			return !lastScanAt || lastScanAt.getTime() <= cutoff.getTime();
		});
		if (dueLibraryIds.length === 0) return;

		this.logger.info("Running periodic library rescan", { libraries: dueLibraryIds.length, intervalHours });

		for (const libraryId of dueLibraryIds) {
			try {
				await this.scanLibraryFn?.(libraryId);
			} catch (error) {
				this.logger.error("Periodic library rescan failed to enqueue", error, { libraryId });
			}
		}
	}

	async syncWatchers(): Promise<void> {
		// Serialize: concurrent syncs from create/update/delete + the reconcile timer
		// could both pass the `!watchers.has(pathId)` check and leak a watcher.
		if (this.isShuttingDown || this.isSyncing) return;

		this.isSyncing = true;
		try {
			if (!serverConfig.scanning.autoWatcherEnabled) {
				this.stopAllWatchers();
				this.logger.debug("Real-time auto watcher is disabled in server settings");

				return;
			}

			await this.safeExecute("syncWatchers", async () => {
				const activePaths = await librariesRepository.findActiveLibraryPaths();
				const activePathIds = new Set(activePaths.map((p) => p.id));
				const activePathById = toMap(activePaths, (p) => p.id);

				// Remove watchers for paths that are no longer active or deleted
				for (const [pathId, entry] of this.watchers.entries()) {
					const current = activePathById.get(pathId);
					const resolvedCurrent = current ? PathUtils.resolve(current.path) : null;
					if (!activePathIds.has(pathId) || entry.path !== resolvedCurrent) {
						this.stopWatcher(pathId);
					}
				}

				// Failures of removed/repointed paths must not linger either.
				for (const [pathId, failure] of this.failures.entries()) {
					const current = activePathById.get(pathId);
					const resolvedCurrent = current ? PathUtils.resolve(current.path) : null;
					if (!activePathIds.has(pathId) || failure.path !== resolvedCurrent) {
						this.clearFailure(pathId);
					}
				}

				// Add watchers for newly active paths
				for (const pathRecord of activePaths) {
					if (!this.watchers.has(pathRecord.id)) {
						await this.startWatcher(pathRecord.libraryId, pathRecord.id, pathRecord.path);
					}
				}

				this.logger.debug("Library watchers synchronized", { activeWatchers: this.watchers.size, unwatchablePaths: this.failures.size });
			});
		} catch {
			// Failures in watcher synchronization are logged by safeExecute and non-fatal for caller
		} finally {
			this.isSyncing = false;
		}
	}

	private async startWatcher(libraryId: string, pathId: string, rawPath: string): Promise<void> {
		const resolvedPath = PathUtils.resolve(rawPath);

		try {
			const exists = await DirUtils.exists(resolvedPath);
			if (!exists) {
				await this.recordFailure(libraryId, pathId, resolvedPath, "path_missing");
				this.logger.debug("Library path does not exist on disk, skipping real-time watcher", {
					libraryId,
					pathId,
					path: resolvedPath,
				});

				return;
			}

			const watcher = watch(resolvedPath, { recursive: true }, (eventType, filename) => {
				this.handleFsEvent(libraryId, pathId, resolvedPath, eventType, filename);
			});

			watcher.on("error", (error) => {
				this.logger.warn("Filesystem watcher encountered an error", {
					libraryId,
					pathId,
					path: resolvedPath,
					error,
				});
				this.stopWatcher(pathId);
				detach(this.recordFailure(libraryId, pathId, resolvedPath, `watcher_error: ${errorMessage(error)}`));
			});

			this.watchers.set(pathId, {
				libraryId,
				pathId,
				path: resolvedPath,
				watcher,
			});
			this.clearFailure(pathId);

			this.logger.info("Started real-time file watcher for library path", {
				libraryId,
				pathId,
				path: resolvedPath,
			});
		} catch (error) {
			await this.recordFailure(libraryId, pathId, resolvedPath, `watch_failed: ${errorMessage(error)}`);
			this.logger.warn("Could not start real-time watcher for library path", {
				libraryId,
				pathId,
				path: resolvedPath,
				error,
			});
		}
	}

	/** Records a path the watcher cannot cover and notifies admins once per episode. */
	private async recordFailure(libraryId: string, pathId: string, path: string, reason: string): Promise<void> {
		const existing = this.failures.get(pathId);
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
			since: this.clock.now(),
			notified: false,
			fallbackTimer: null,
		};
		this.failures.set(pathId, entry);
		this.logger.error("Real-time watching unavailable for library path", { libraryId, pathId, path, reason });
		this.armFallback(entry);

		entry.notified = true;
		try {
			await this.notifyFailure({ libraryId, pathId, path, reason, since: entry.since });
		} catch (error) {
			this.logger.warn("Failed to notify administrators about an unwatchable library path", { libraryId, pathId, error });
		}
	}

	/** Schedules the next periodic fallback scan for an unwatchable path (0 = disabled). */
	private armFallback(entry: WatcherFailureEntry): void {
		const intervalMinutes = serverConfig.scanning.watcherFallbackIntervalMinutes;
		if (intervalMinutes <= 0) return;

		entry.fallbackTimer = this.clock.setTimeout(() => this.runFallback(entry.pathId), intervalMinutes * 60_000);
		this.clock.unrefTimer?.(entry.fallbackTimer);
	}

	/**
	 * Rescans a path whose watcher is unavailable, then re-arms. Never throws:
	 * the timer callback owns the promise, and a failing scan must not kill the
	 * schedule (the reconcile loop clears the failure on recovery).
	 */
	private async runFallback(pathId: string): Promise<void> {
		try {
			const entry = this.failures.get(pathId);
			if (!entry) return;

			if (this.isShuttingDown || !serverConfig.scanning.autoWatcherEnabled) return;

			// Server rescue pauses background work — re-check soon instead of scanning.
			if (serverRescueService.isThrottling()) {
				entry.fallbackTimer = this.clock.setTimeout(() => this.runFallback(pathId), RESCUE_RECHECK_MS);
				this.clock.unrefTimer?.(entry.fallbackTimer);

				return;
			}

			this.logger.info("Running fallback scan for a path without a real-time watcher", {
				libraryId: entry.libraryId,
				pathId,
				path: entry.path,
			});

			try {
				await this.scanPathFn?.(entry.libraryId, pathId);
			} catch (error) {
				this.logger.error("Fallback scan for an unwatchable library path failed", error, { libraryId: entry.libraryId, pathId });
			}

			this.armFallback(entry);
		} catch (error) {
			this.logger.error("Fallback scan scheduling failed", error, { pathId });
		}
	}

	/** Drops the failure state for a path (watcher recovered or path removed). */
	private clearFailure(pathId: string): void {
		const entry = this.failures.get(pathId);
		if (!entry) return;

		if (entry.fallbackTimer !== null) this.clock.clearTimeout(entry.fallbackTimer);
		this.failures.delete(pathId);
	}

	/** Paths the filesystem watcher currently cannot cover. */
	getUnwatchablePaths(): WatcherFailureInfo[] {
		return [...this.failures.values()].map(({ libraryId, pathId, path, reason, since }) => ({ libraryId, pathId, path, reason, since }));
	}

	/** Entry point for fs events; public so tests can drive the state machine
	 * without real filesystem watchers. */
	handleFsEvent(libraryId: string, pathId: string, rootPath: string, eventType: string, filename: string | null): void {
		if (this.isShuttingDown || !serverConfig.scanning.autoWatcherEnabled) return;

		// Filter out temporary and hidden files
		if (filename && isIgnoredRelativePath(filename)) {
			return;
		}

		this.logger.debug("Filesystem change detected in library path", {
			libraryId,
			pathId,
			eventType,
			filename: filename ?? "(unknown)",
		});

		const scanKey = `${libraryId}:${pathId}`;
		const existing = this.pendingScans.get(scanKey);
		if (existing) {
			this.clock.clearTimeout(existing.timer);
		}

		// Re-arm the debounce. Events arriving during a cooldown keep a pending entry
		// alive, so a catch-up scan still runs when the cooldown expires.
		const delayMs = Math.max(2, serverConfig.scanning.autoWatcherDelaySeconds) * 1000;
		this.pendingScans.set(scanKey, { timer: this.armScanTimer(scanKey, libraryId, pathId, rootPath, delayMs) });
	}

	private armScanTimer(scanKey: string, libraryId: string, pathId: string, rootPath: string, delayMs: number): unknown {
		const timer = this.clock.setTimeout(() => this.fireScan(scanKey, libraryId, pathId, rootPath), delayMs);
		this.clock.unrefTimer?.(timer);

		return timer;
	}

	private async fireScan(scanKey: string, libraryId: string, pathId: string, rootPath: string): Promise<void> {
		const state = this.pendingScans.get(scanKey);
		if (!state) return;

		if (this.isShuttingDown || !serverConfig.scanning.autoWatcherEnabled) {
			this.clock.clearTimeout(state.timer);
			this.pendingScans.delete(scanKey);

			return;
		}

		const delaySeconds = serverConfig.scanning.autoWatcherDelaySeconds;

		// Server rescue active: background work is paused, so hold the scan (the pending
		// entry stays alive) and re-check until the system recovers.
		if (serverRescueService.isThrottling()) {
			this.clock.clearTimeout(state.timer);
			state.timer = this.armScanTimer(scanKey, libraryId, pathId, rootPath, RESCUE_RECHECK_MS);
			this.logger.debug("Filesystem changes held: server rescue is active, scan postponed", { libraryId, pathId });

			return;
		}

		// Cooldown: minimum gap between two watcher-triggered scans of the same path.
		// During bulk copies the debounce fires after every quiet gap; the cooldown
		// collapses those into one scan per window. The pending entry stays alive so
		// the final catch-up scan still runs when the cooldown expires.
		const cooldownUntil = this.cooldowns.get(scanKey) ?? 0;
		const remainingMs = cooldownUntil - this.clock.now();
		if (remainingMs > 0) {
			this.clock.clearTimeout(state.timer);
			state.timer = this.armScanTimer(scanKey, libraryId, pathId, rootPath, remainingMs);
			this.logger.debug("Filesystem changes held: scan cooldown active", {
				libraryId,
				pathId,
				remainingMs,
			});

			return;
		}

		this.pendingScans.delete(scanKey);
		const cooldownSeconds = serverConfig.scanning.autoWatcherCooldownSeconds;
		if (cooldownSeconds > 0) {
			this.cooldowns.set(scanKey, this.clock.now() + cooldownSeconds * 1000);
		} else {
			this.cooldowns.delete(scanKey);
		}

		this.logger.info("Filesystem changes settled, triggering automatic library scan", {
			libraryId,
			pathId,
			rootPath,
			delaySeconds,
			cooldownSeconds,
		});

		try {
			await this.scanPathFn?.(libraryId, pathId);
		} catch (error) {
			this.logger.error("Failed to automatically scan library path after changes settled", error, {
				libraryId,
				pathId,
				rootPath,
			});
		}
	}

	stopWatcher(pathId: string): void {
		const entry = this.watchers.get(pathId);
		if (entry) {
			try {
				entry.watcher.close();
			} catch {
				// intentionally empty
			}

			this.watchers.delete(pathId);
			this.logger.debug("Stopped real-time watcher for library path", { pathId, path: entry.path });
		}

		// Clear any pending debounce timer for this path
		for (const [key, state] of this.pendingScans.entries()) {
			if (key.endsWith(`:${pathId}`)) {
				this.clock.clearTimeout(state.timer);
				this.pendingScans.delete(key);
				this.cooldowns.delete(key);
			}
		}

		// Also drop a cooldown whose pending scan already fired — otherwise the
		// timestamp lingers for a removed path until restart.
		for (const key of this.cooldowns.keys()) {
			if (key.endsWith(`:${pathId}`)) this.cooldowns.delete(key);
		}

		this.clearFailure(pathId);
	}

	stopAllWatchers(): void {
		for (const entry of this.watchers.values()) {
			try {
				entry.watcher.close();
			} catch {
				// intentionally empty
			}
		}

		this.watchers.clear();

		for (const state of this.pendingScans.values()) {
			this.clock.clearTimeout(state.timer);
		}

		this.pendingScans.clear();
		this.cooldowns.clear();

		for (const entry of this.failures.values()) {
			if (entry.fallbackTimer !== null) this.clock.clearTimeout(entry.fallbackTimer);
		}

		this.failures.clear();
	}

	shutdown(): void {
		this.isShuttingDown = true;
		if (this.reconcileTimer) {
			clearInterval(this.reconcileTimer);
			this.reconcileTimer = null;
		}

		this.stopAllWatchers();
		this.logger.info("Library watcher service shut down successfully");
	}

	getActiveWatcherCount(): number {
		return this.watchers.size;
	}

	getPendingTimerCount(): number {
		return this.pendingScans.size;
	}
}

export const libraryWatcherService = new LibraryWatcherService();
