import { detach } from "@/utils/promise.utils";

/**
 * Serializes runs per key — for a library, a watcher-triggered scan must not
 * interleave with a scheduled one. Runs queue behind the previous one; a failed
 * predecessor never blocks the successor. The lock mirrors settlement only, so
 * callers of `run` still receive the task's own result or rejection.
 */
export class LibraryRunLock {
	private readonly locks = new Map<string, Promise<unknown>>();

	run<T>(key: string, task: () => Promise<T>): Promise<T> {
		const previous = this.locks.get(key) ?? Promise.resolve();
		const current = (async () => {
			try {
				await previous;
			} catch {
				// A failed previous run must not block the new one.
			}

			return await task();
		})();
		const settled = (async () => {
			try {
				await current;
			} catch {
				// Failures belong to `current` callers.
			}
		})();
		this.locks.set(key, settled);
		// Drop the lock once it settles, but only if no newer run replaced it —
		// otherwise the map would retain one entry per key for the process lifetime.
		detach(
			(async () => {
				try {
					await settled;
				} finally {
					if (this.locks.get(key) === settled) this.locks.delete(key);
				}
			})(),
		);

		return current;
	}
}
