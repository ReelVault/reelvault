/** Time source for the debounce/cooldown state machine. Tests inject a manual
 * clock; production uses real timers + wall clock. */
export interface LibraryWatcherClock<TTimer = unknown> {
	setTimeout(callback: () => unknown, ms: number): TTimer;
	clearTimeout(timer: TTimer): void;
	now(): number;
	/** Best-effort timer unref; optional so manual test clocks can omit it. */
	unrefTimer?(timer: TTimer): void;
}

export const defaultClock: LibraryWatcherClock<Timer> = {
	setTimeout: (callback, ms) => setTimeout(callback, ms),
	clearTimeout: (timer) => clearTimeout(timer),
	now: () => Date.now(),
	unrefTimer: (timer) => timer.unref(),
};

/** While the server rescue system is throttling, re-check this often instead of scanning. */
export const RESCUE_RECHECK_MS = 5_000;
/** Periodic reconcile: re-arm watchers lost to a missing mount or an fs error. */
export const WATCHER_RECONCILE_INTERVAL_MS = 60_000;

/** Arms a timer on the clock and lets it go without keeping the process alive. */
export function armTimer(clock: LibraryWatcherClock, callback: () => unknown, ms: number): unknown {
	const timer = clock.setTimeout(callback, ms);
	clock.unrefTimer?.(timer);

	return timer;
}
