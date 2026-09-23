import { type FSWatcher, watch } from "node:fs";
import { librariesRepository } from "@/database/repositories/libraries.repository";
import { serverConfig } from "@/server.config";
import { serverRescueService } from "@/system/server-rescue.service";
import { toMap } from "@/utils/array.utils";
import { BaseService } from "@/utils/base-service";
import { DirUtils } from "@/utils/directory.utils";
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

	private readonly clock: LibraryWatcherClock;
	private isInitialized = false;
	private isShuttingDown = false;
	private isSyncing = false;
	private reconcileTimer: ReturnType<typeof setInterval> | null = null;
	/**
	 * Scan trigger registered by `librariesService` at construction. Avoids a
	 * direct import back into `libraries.service` (import cycle).
	 */
	private scanPathFn?: ((libraryId: string, pathId: string) => Promise<unknown>) | undefined;

	constructor(clock: LibraryWatcherClock = defaultClock) {
		super("LibraryWatcherService");
		this.clock = clock;
	}

	registerScanner(fn: (libraryId: string, pathId: string) => Promise<unknown>): void {
		this.scanPathFn = fn;
	}

	async init(): Promise<void> {
		if (this.isInitialized) return;

		this.isInitialized = true;
		this.logger.info("Initializing library watcher service...");
		await this.syncWatchers();
		// Periodically reconcile so a watcher lost to a transient mount failure or
		// an fs error is re-armed without waiting for an admin to edit the library.
		if (!this.reconcileTimer) {
			this.reconcileTimer = setInterval(() => {
				detach(this.syncWatchers());
			}, WATCHER_RECONCILE_INTERVAL_MS);
			this.reconcileTimer.unref();
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

				// Add watchers for newly active paths
				for (const pathRecord of activePaths) {
					if (!this.watchers.has(pathRecord.id)) {
						await this.startWatcher(pathRecord.libraryId, pathRecord.id, pathRecord.path);
					}
				}

				this.logger.debug("Library watchers synchronized", { activeWatchers: this.watchers.size });
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
			});

			this.watchers.set(pathId, {
				libraryId,
				pathId,
				path: resolvedPath,
				watcher,
			});

			this.logger.info("Started real-time file watcher for library path", {
				libraryId,
				pathId,
				path: resolvedPath,
			});
		} catch (error) {
			this.logger.warn("Could not start real-time watcher for library path", {
				libraryId,
				pathId,
				path: resolvedPath,
				error,
			});
		}
	}

	/** Entry point for fs events; public so tests can drive the state machine
	 * without real filesystem watchers. */
	handleFsEvent(libraryId: string, pathId: string, rootPath: string, eventType: string, filename: string | null): void {
		if (this.isShuttingDown || !serverConfig.scanning.autoWatcherEnabled) return;

		// Filter out temporary and hidden files
		if (filename && this.shouldIgnoreFile(filename)) {
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

	private shouldIgnoreFile(filename: string): boolean {
		const normalized = filename.replaceAll("\\", "/");
		const segments = normalized.split("/");

		for (const segment of segments) {
			// Ignore hidden files and folders (.git, .DS_Store, .tmp, etc.)
			if (segment.startsWith(".") && segment !== "." && segment !== "..") {
				return true;
			}

			// Ignore swap and temporary backup files
			if (segment.endsWith("~") || segment.endsWith(".tmp") || segment.endsWith(".part") || segment.endsWith(".crdownload")) {
				return true;
			}
		}

		return false;
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
