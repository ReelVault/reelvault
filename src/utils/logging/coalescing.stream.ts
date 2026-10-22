import { Writable } from "node:stream";

/** How long a coalesced log batch may wait before it is written out. */
const LOG_COALESCE_FLUSH_MS = 2;

/**
 * A log target. A file stream offers `flush()` to reach the disk; Bun's
 * `process.stdout` carries a boolean `flush` instead, which must not be called.
 */
type LogTarget = Writable & { flush?: (() => Promise<void>) | boolean };

/**
 * Batches log lines into one target write per flush window. Per-line writes
 * cost a libuv request each; at request-log volume that event-loop churn shows
 * up as throughput loss. Lines are accepted immediately — the pending buffer is
 * bounded by the flush cadence and the target's write latency — and written as
 * one buffer in arrival order.
 */
export class CoalescingStream extends Writable {
	private readonly target: LogTarget;
	private pending: Buffer[] = [];
	private timer: ReturnType<typeof setTimeout> | undefined;
	private flushing = false;
	private finalCallback: ((error?: Error | null) => void) | undefined;
	private drainWaiters: Array<() => void> = [];

	constructor(target: LogTarget) {
		super();
		this.target = target;
	}

	/** Hands every line accepted so far to the target. Process exit cannot wait for the flush timer, so shutdown awaits this first. */
	drain(): Promise<void> {
		return new Promise<void>((resolve) => {
			this.drainWaiters.push(resolve);
			this.flush();
			this.settleDrain();
		}).then(async () => {
			if (typeof this.target.flush === "function") await this.target.flush();
		});
	}

	override _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
		this.pending.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
		callback();
		this.scheduleFlush();
	}

	override _final(callback: (error?: Error | null) => void): void {
		this.finalCallback = callback;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}

		this.flush();
	}

	private scheduleFlush(): void {
		if (this.timer || this.flushing || this.finalCallback) return;

		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.flush();
		}, LOG_COALESCE_FLUSH_MS);
		this.timer.unref();
	}

	private flush(): void {
		if (this.flushing) return;

		if (this.pending.length === 0) {
			this.finishTarget();
			this.settleDrain();

			return;
		}

		const batch = this.pending.length === 1 ? this.pending[0] : Buffer.concat(this.pending);
		this.pending = [];
		this.flushing = true;

		this.target.write(batch, (error) => {
			this.flushing = false;
			if (error) {
				// Nothing can be written after the destroy, so the lines still pending are dropped with it.
				this.pending = [];
				this.settleDrain();
				this.destroy(error);

				return;
			}

			if (this.pending.length > 0) this.scheduleFlush();
			else this.finishTarget();
			this.settleDrain();
		});
	}

	/** Resolves drain waiters once nothing is pending and no write is in flight. */
	private settleDrain(): void {
		if (this.flushing || this.pending.length > 0) return;

		const waiters = this.drainWaiters;
		this.drainWaiters = [];
		for (const resolve of waiters) resolve();
	}

	/** Ends the target once nothing is pending and no write is in flight. */
	private finishTarget(): void {
		if (!this.finalCallback || this.flushing) return;

		const callback = this.finalCallback;
		this.finalCallback = undefined;
		this.target.end(callback);
	}
}
