import { createLogger } from "@/utils/logger.utils";
import { detach } from "@/utils/promise.utils";
import { handleFsEvent } from "./debounce.watcher";
import { getUnwatchablePaths, notifyAdminsOfWatcherFailure } from "./failures.tracker";
import { stopAllWatchers, stopWatcher, syncWatchers } from "./paths.watcher";
import { runScheduledScanIfDue } from "./scheduled.scheduler";
import type { LibraryWatcherState, WatchedPathEntry, WatcherFailureInfo } from "./state.types";
import { defaultClock, type LibraryWatcherClock, WATCHER_RECONCILE_INTERVAL_MS } from "./timing.utils";

export type { WatcherFailureInfo } from "./state.types";
export type { LibraryWatcherClock } from "./timing.utils";

export class LibraryWatcherService {
	readonly serviceName = "LibraryWatcherService";
	readonly logger = createLogger("LibraryWatcherService");

	private readonly state: LibraryWatcherState;
	private reconcileTimer: ReturnType<typeof setInterval> | null = null;

	constructor(
		clock: LibraryWatcherClock = defaultClock,
		notifyFailure: (failure: WatcherFailureInfo) => Promise<void> = notifyAdminsOfWatcherFailure,
	) {
		this.state = {
			serviceName: this.serviceName,
			logger: this.logger,
			clock,
			notifyFailure,
			watchers: new Map<string, WatchedPathEntry>(),
			pendingScans: new Map(),
			cooldowns: new Map<string, number>(),
			failures: new Map(),
			isInitialized: false,
			isShuttingDown: false,
			isSyncing: false,
		};
	}

	registerScanner(fn: (libraryId: string, pathId: string) => Promise<unknown>): void {
		this.state.scanPathFn = fn;
	}

	/** Registers the whole-library scan used by `scanning.scheduledScanIntervalHours`. */
	registerLibraryScanner(fn: (libraryId: string) => Promise<unknown>): void {
		this.state.scanLibraryFn = fn;
	}

	async init(): Promise<void> {
		if (this.state.isInitialized) return;

		this.state.isInitialized = true;
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

	/** Public so tests can drive the periodic rescan with a manual clock. */
	async runScheduledScanIfDue(): Promise<void> {
		await runScheduledScanIfDue(this.state);
	}

	async syncWatchers(): Promise<void> {
		await syncWatchers(this.state);
	}

	stopWatcher(pathId: string): void {
		stopWatcher(this.state, pathId);
	}

	stopAllWatchers(): void {
		stopAllWatchers(this.state);
	}

	getUnwatchablePaths(): WatcherFailureInfo[] {
		return getUnwatchablePaths(this.state);
	}

	/** Public so tests can drive the state machine without real filesystem watchers. */
	handleFsEvent(libraryId: string, pathId: string, rootPath: string, eventType: string, filename: string | null): void {
		handleFsEvent(this.state, { libraryId, pathId, rootPath }, eventType, filename);
	}

	shutdown(): void {
		this.state.isShuttingDown = true;
		if (this.reconcileTimer) {
			clearInterval(this.reconcileTimer);
			this.reconcileTimer = null;
		}

		stopAllWatchers(this.state);
		this.logger.info("Library watcher service shut down successfully");
	}

	getActiveWatcherCount(): number {
		return this.state.watchers.size;
	}

	getPendingTimerCount(): number {
		return this.state.pendingScans.size;
	}
}

export const libraryWatcherService = new LibraryWatcherService();
