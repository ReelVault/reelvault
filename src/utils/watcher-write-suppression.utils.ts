import { resolve } from "node:path";

/** A core sidecar write emits an fs event; suppress it long enough for the watcher to see it. */
const SUPPRESS_TTL_MS = 10_000;
/** Bound the map even under a pathological metadata refresh; expired entries are pruned on write. */
const MAX_SUPPRESSED_PATHS = 10_000;

const suppressedUntil = new Map<string, number>();
let writesSincePrune = 0;

function pruneExpired(now: number): void {
	for (const [path, until] of suppressedUntil) {
		if (until <= now) suppressedUntil.delete(path);
	}
}

/** Marks a path this process is about to write, so its own watcher event does not trigger a scan. */
export function suppressWatcherPath(path: string, ttlMs = SUPPRESS_TTL_MS): void {
	const now = Date.now();
	writesSincePrune++;
	if (writesSincePrune >= 256 || suppressedUntil.size >= MAX_SUPPRESSED_PATHS) {
		writesSincePrune = 0;
		pruneExpired(now);
	}

	suppressedUntil.set(resolve(path), now + ttlMs);
}

/** True while the path was written by core and its fs event should be ignored. */
export function isWatcherPathSuppressed(path: string): boolean {
	const key = resolve(path);
	const until = suppressedUntil.get(key);
	if (until === undefined) return false;
	if (until <= Date.now()) {
		suppressedUntil.delete(key);

		return false;
	}

	return true;
}
