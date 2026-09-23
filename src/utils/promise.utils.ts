import { watch } from "node:fs/promises";
import { file } from "bun";
import { createLogger } from "@/utils/logger";
import { PathUtils } from "@/utils/path.utils";

const logger = createLogger("PromiseUtils");

/**
 * Fire-and-forget for promises that cannot reject: the task handles its own
 * errors. Must never be used with a promise that may reject (an unhandled
 * rejection would crash the process) — wrap such tasks in a try/catch first.
 */
export function detach(_promise: Promise<unknown>): void {
	// Detached intentionally: errors are owned by the task itself.
}

export const PromiseUtils = {
	sleep: (ms: number) =>
		new Promise((resolve) => {
			setTimeout(resolve, ms);
		}),

	async withTimeout<T>(promise: Promise<T>, ms: number, label?: string): Promise<Awaited<T>> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => reject(new Error(label ? `${label} exceeded ${ms}ms timeout` : "Timeout")), ms);
			timer.unref();
		});

		try {
			return await Promise.race([promise, timeout]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	},

	async mapConcurrent<T, R>(
		items: readonly T[],
		concurrency: number | (() => number),
		mapper: (item: T, index: number) => Promise<R>,
		signal?: AbortSignal,
	): Promise<R[]> {
		const resolvedConcurrency = typeof concurrency === "function" ? concurrency() : concurrency;
		if (!Number.isInteger(resolvedConcurrency) || resolvedConcurrency < 1) throw new Error("Concurrency must be a positive integer");

		if (items.length === 0) return [];

		const results = Array.from<R>({ length: items.length });
		let nextIndex = 0;
		const workers = Array.from({ length: Math.min(resolvedConcurrency, items.length) }, async () => {
			while (nextIndex < items.length) {
				if (signal?.aborted) throw signal.reason ?? new Error("Operation aborted");

				const index = nextIndex++;
				const item = items[index];
				if (item !== undefined) results[index] = await mapper(item, index);
			}
		});

		await Promise.all(workers);

		return results;
	},

	/**
	 * Waits for a file to appear on disk using fs.watch (event-driven).
	 * Falls back to non-blocking polling only if the watcher cannot be created.
	 * Resolves when found, rejects after timeoutMs or when `signal` aborts
	 * (rejecting with the signal's reason when present).
	 *
	 * Watchers are shared per directory (ref-counted) — hls.js frequently
	 * requests several missing segments of the same session directory at once,
	 * and one watcher per call multiplied inotify handles.
	 */
	waitForFile(filePath: string, timeoutMs = 10_000, pollMs = 200, signal?: AbortSignal): Promise<void> {
		return new Promise((resolve, reject) => {
			let resolved = false;
			let pollTimer: ReturnType<typeof setInterval> | null = null;
			let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
			let releaseWatcher: (() => void) | null = null;

			function cleanup(): void {
				resolved = true;
				signal?.removeEventListener("abort", onAborted);
				releaseWatcher?.();
				releaseWatcher = null;
				if (pollTimer) clearInterval(pollTimer);

				if (timeoutTimer) clearTimeout(timeoutTimer);
			}

			function onAborted(): void {
				if (resolved) return;

				cleanup();
				reject(signal?.reason ?? new Error(`Waiting for file aborted: ${filePath}`));
			}

			if (signal?.aborted) {
				onAborted();

				return;
			}

			signal?.addEventListener("abort", onAborted, { once: true });

			const onFound = () => {
				if (resolved) return;

				cleanup();
				resolve();
			};

			// Best-effort existence probe; failures just mean "not yet".
			const checkExists = async (): Promise<void> => {
				try {
					if (await file(filePath).exists()) onFound();
				} catch {
					// still not found
				}
			};

			function startPolling(): void {
				if (pollTimer) return;

				pollTimer = setInterval(() => {
					detach(checkExists());
				}, pollMs);
				pollTimer.unref();
			}

			const onError = () => {
				if (resolved || pollTimer) return;

				startPolling();
			};

			/**
			 * Polling is armed unconditionally as a safety net: fs.watch events are
			 * not reliably delivered on every runtime/filesystem combination (e.g.
			 * Bun on tmpfs never fires), which previously stalled the wait until the
			 * full timeout even though the file existed. The dir watcher stays armed
			 * as the fast path; polling only stats a missing file every `pollMs`.
			 */

			timeoutTimer = setTimeout(() => {
				if (!resolved) {
					cleanup();
					reject(new Error(`Timeout waiting for file: ${filePath}`));
				}
			}, timeoutMs);
			timeoutTimer.unref();

			const targetName = PathUtils.getFileName(filePath);
			const directory = PathUtils.getDirName(filePath);

			releaseWatcher = subscribeDirWatcher(
				directory,
				(filename) => {
					if (filename === targetName) {
						onFound();
					} else if (filename === null) {
						// Unknown filename (platform-dependent) — verify instead of assuming.
						detach(checkExists());
					}
				},
				onError,
			);

			startPolling();

			// Re-check after subscribing — the file may have been created between
			// the initial exists() call and the watcher being armed.
			detach(checkExists());
		});
	},

	createSemaphore(maxConcurrency: number | (() => number)) {
		const getMax = () => (typeof maxConcurrency === "function" ? maxConcurrency() : maxConcurrency);
		let active = 0;
		interface Waiter {
			resolve: () => void;
			reject: (reason?: unknown) => void;
			signal?: AbortSignal | undefined;
		}
		const queue: Array<Waiter | undefined> = [];
		let head = 0;

		const release = (): void => {
			active--;
			const max = Math.max(1, getMax());
			while (active < max && head < queue.length) {
				const next = queue[head];
				queue[head] = undefined;
				head++;
				if (next) {
					if (next.signal?.aborted) continue;

					active++;
					next.resolve();
				}
			}

			if (head === queue.length) {
				queue.length = 0;
				head = 0;
			} else if (head > 64) {
				// Trim consumed slots periodically instead of shifting (O(n)) per release.
				queue.splice(0, head);
				head = 0;
			}
		};

		const acquire = async (signal?: AbortSignal): Promise<void> => {
			if (signal?.aborted) {
				throw signal.reason ?? new Error("Operation aborted");
			}

			const max = Math.max(1, getMax());
			if (active < max) {
				active++;

				return;
			}

			return await new Promise<void>((resolve, reject) => {
				let onAbort: (() => void) | undefined;
				const waiter: Waiter = {
					resolve: () => {
						if (onAbort && signal) signal.removeEventListener("abort", onAbort);

						resolve();
					},
					reject,
					signal,
				};

				if (signal) {
					onAbort = () => {
						const index = queue.indexOf(waiter);
						if (index !== -1) {
							queue[index] = undefined;
							reject(signal.reason ?? new Error("Operation aborted"));
						}
					};
					signal.addEventListener("abort", onAbort, { once: true });
				}

				queue.push(waiter);
			});
		};

		const run = async <T>(operation: () => Promise<T> | T, signal?: AbortSignal): Promise<T> => {
			await acquire(signal);
			try {
				if (signal?.aborted) {
					throw signal.reason ?? new Error("Operation aborted");
				}

				return await operation();
			} finally {
				release();
			}
		};

		return {
			acquire,
			release,
			run,
			get activeCount(): number {
				return active;
			},
			get queuedCount(): number {
				return Math.max(0, queue.length - head);
			},
		};
	},
};

interface DirWatcherEntry {
	controller: AbortController;
	refs: number;
	listeners: Set<(filename: string | null) => void>;
	errorListeners: Set<() => void>;
	task: Promise<void>;
}

const dirWatchers = new Map<string, DirWatcherEntry>();

/**
 * Shares a single fs.watch handle per directory across all concurrent waiters.
 * Multiple missing HLS segments of the same session previously armed one
 * watcher per request; the returned function releases the caller's reference
 * and tears the watcher down when the last waiter leaves.
 */
function subscribeDirWatcher(directory: string, onEvent: (filename: string | null) => void, onError: () => void): () => void {
	const existing = dirWatchers.get(directory);
	if (existing) {
		existing.refs++;
		existing.listeners.add(onEvent);
		existing.errorListeners.add(onError);

		return () => {
			existing.listeners.delete(onEvent);
			existing.errorListeners.delete(onError);
			existing.refs--;
			if (existing.refs <= 0) {
				existing.controller.abort();
				if (dirWatchers.get(directory) === existing) dirWatchers.delete(directory);
			}
		};
	}

	const entry: DirWatcherEntry = {
		controller: new AbortController(),
		refs: 1,
		listeners: new Set([onEvent]),
		errorListeners: new Set([onError]),
		task: Promise.resolve(),
	};
	entry.task = (async () => {
		try {
			const watcher = watch(directory, { recursive: false, signal: entry.controller.signal });
			for await (const event of watcher) {
				for (const listener of entry.listeners) {
					listener(event.filename ?? null);
				}
			}
		} catch {
			// Aborted by the last waiter releasing — nothing to do. Any other
			// failure (ENOENT, permission) is surfaced so waiters can poll.
			if (!entry.controller.signal.aborted) {
				logger.warn("Directory watcher failed — falling back to polling", { directory });
				for (const errorListener of entry.errorListeners) {
					errorListener();
				}
			}
		} finally {
			if (dirWatchers.get(directory) === entry) dirWatchers.delete(directory);
		}
	})();
	dirWatchers.set(directory, entry);

	return () => {
		entry.listeners.delete(onEvent);
		entry.errorListeners.delete(onError);
		entry.refs--;
		if (entry.refs <= 0) {
			entry.controller.abort();
			if (dirWatchers.get(directory) === entry) dirWatchers.delete(directory);
		}
	};
}
