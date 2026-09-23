import type { PlaybackDecision } from "@sdk/common/stream.types";
import { detach } from "@/utils/promise.utils";
import type { SeekResult } from "../streaming.types";

interface SeekWaiter {
	resolve: (result: SeekResult) => void;
	reject: (error: unknown) => void;
}

interface PendingSeek {
	timer: Timer | null;
	offset: number;
	decision: PlaybackDecision;
	waiters: SeekWaiter[];
}

export type SeekExecutor = (sessionId: string, offset: number, decision: PlaybackDecision) => Promise<number | undefined>;

/**
 * Debounces rapid-fire seeks (timeline scrubbing) and serializes actual seek
 * execution per session via a mutex chain, so two seeks on the same session
 * can never race against each other.
 */
export class SeekScheduler {
	private readonly pending = new Map<string, PendingSeek>();
	private readonly locks = new Map<string, Promise<void>>();
	private readonly seekingIds = new Set<string>();

	private readonly debounceMs: number;
	private readonly execute: SeekExecutor;

	constructor(debounceMs: number, execute: SeekExecutor) {
		this.debounceMs = debounceMs;
		this.execute = execute;
	}

	isSeeking(sessionId: string): boolean {
		return this.seekingIds.has(sessionId);
	}

	/**
	 * Resolves immediately with a buffered result, cancelling any pending debounce.
	 */
	resolveWithBufferedResult(sessionId: string, result: SeekResult): void {
		const pending = this.pending.get(sessionId);
		if (!pending) return;

		if (pending.timer) clearTimeout(pending.timer);

		this.pending.delete(sessionId);
		for (const waiter of pending.waiters) waiter.resolve(result);
	}

	schedule(sessionId: string, offset: number, decision: PlaybackDecision): Promise<SeekResult> {
		return new Promise<SeekResult>((resolve, reject) => {
			const existing = this.pending.get(sessionId);
			const pending: PendingSeek = existing ?? { timer: null, offset, decision, waiters: [] };

			if (pending.timer) clearTimeout(pending.timer);

			pending.offset = offset;
			pending.decision = decision;
			pending.waiters.push({ resolve, reject });
			pending.timer = setTimeout(() => {
				detach(this.flushSilently(sessionId, pending));
			}, this.debounceMs);
			pending.timer.unref();

			this.pending.set(sessionId, pending);
		});
	}

	/**
	 * Rejects every pending/queued seek. Used on shutdown.
	 */
	cancelAll(reason: string): void {
		for (const pending of this.pending.values()) {
			if (pending.timer) clearTimeout(pending.timer);

			for (const waiter of pending.waiters) waiter.reject(new Error(reason));
		}

		this.pending.clear();
	}

	/**
	 * Removes the lock for a specific session. Called from StreamingService
	 * after a session is terminated to prevent stale locks from blocking
	 * a new session that reuses the same sessionId.
	 */
	cancelSessionLock(sessionId: string): void {
		this.locks.delete(sessionId);
	}

	/**
	 * Runs `task` under the same per-session mutex that serializes seeks. Used by
	 * the software-encoder fallback restart so a seek and a fallback restart can
	 * never both tear down + restart the same session concurrently.
	 */
	async runExclusive<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
		const previousLock = this.locks.get(sessionId) ?? Promise.resolve();
		const { run, lock } = this.chainLocked(sessionId, previousLock, task);
		try {
			return await run;
		} finally {
			if (this.locks.get(sessionId) === lock) this.locks.delete(sessionId);
		}
	}

	/**
	 * Chains `task` onto `previousLock` (it starts once the previous entry settles,
	 * regardless of its outcome) and installs the settled mirror as the new lock.
	 */
	private chainLocked<T>(sessionId: string, previousLock: Promise<void>, task: () => Promise<T>): { run: Promise<T>; lock: Promise<void> } {
		const run = (async () => {
			await previousLock;

			return await task();
		})();
		const lock = (async () => {
			try {
				await run;
			} catch {
				// The lock mirrors settlement only; failures belong to the caller of `run`.
			}
		})();
		this.locks.set(sessionId, lock);

		return { run, lock };
	}

	/** Flush wrapper that can never reject: flush delivers failures to its waiters. */
	private async flushSilently(sessionId: string, pending: PendingSeek): Promise<void> {
		try {
			await this.flush(sessionId, pending);
		} catch {
			// Errors are delivered to waiters inside flush(); nothing more to do here.
		}
	}

	private async flush(sessionId: string, pending: PendingSeek): Promise<void> {
		if (this.pending.get(sessionId) !== pending) return;

		this.pending.delete(sessionId);

		const previousLock = this.locks.get(sessionId) ?? Promise.resolve();
		const { run: seek, lock } = this.chainLocked(sessionId, previousLock, () =>
			this.runExecutor(sessionId, pending.offset, pending.decision),
		);

		try {
			// Executor returns the actual content start (may differ from the requested
			// offset when stream copy begins at the preceding keyframe).
			const actualStart = await seek;
			for (const waiter of pending.waiters) waiter.resolve({ startTime: actualStart ?? pending.offset, reusedBuffer: false });
		} catch (error) {
			for (const waiter of pending.waiters) waiter.reject(error);
		} finally {
			if (this.locks.get(sessionId) === lock) this.locks.delete(sessionId);
		}
	}

	private async runExecutor(sessionId: string, offset: number, decision: PlaybackDecision): Promise<number | undefined> {
		this.seekingIds.add(sessionId);
		try {
			return await this.execute(sessionId, offset, decision);
		} finally {
			this.seekingIds.delete(sessionId);
		}
	}
}
