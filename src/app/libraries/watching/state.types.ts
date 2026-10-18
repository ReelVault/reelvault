import type { FSWatcher } from "node:fs";
import type { Logger } from "@reelvault/sdk/common";
import type { LibraryWatcherClock } from "./timing.utils";

export interface WatchedPathEntry {
	libraryId: string;
	pathId: string;
	path: string;
	watcher: FSWatcher;
}

/** `${libraryId}:${pathId}` → the debounce timer that will fire a scan. */
export interface PendingScanState {
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

export interface WatcherFailureEntry extends WatcherFailureInfo {
	notified: boolean;
	fallbackTimer: unknown;
}

/** Everything the watcher functions share: the registries, the clock and the callbacks wired by the facade. */
export interface LibraryWatcherState {
	readonly serviceName: string;
	readonly logger: Logger;
	readonly clock: LibraryWatcherClock;
	readonly notifyFailure: (failure: WatcherFailureInfo) => Promise<void>;
	readonly watchers: Map<string, WatchedPathEntry>;
	readonly pendingScans: Map<string, PendingScanState>;
	/** `${libraryId}:${pathId}` → earliest moment the next watcher-triggered scan may fire. */
	readonly cooldowns: Map<string, number>;
	/** pathId → a path the filesystem watcher cannot cover. */
	readonly failures: Map<string, WatcherFailureEntry>;
	isInitialized: boolean;
	isShuttingDown: boolean;
	isSyncing: boolean;
	/**
	 * Scan trigger registered by `librariesService` at construction. Avoids a
	 * direct import back into `libraries.service` (import cycle).
	 */
	scanPathFn?: ((libraryId: string, pathId: string) => Promise<unknown>) | undefined;
	/** Whole-library scan trigger used by the periodic rescan. */
	scanLibraryFn?: ((libraryId: string) => Promise<unknown>) | undefined;
}
