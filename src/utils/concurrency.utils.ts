/**
 * Per-key serialisation — callers with the same key run one after another in arrival order,
 * different keys still run concurrently. A failed section never blocks the ones queued behind it.
 * Use one key for a global lock (e.g. a single shared resource).
 */
export class KeyedMutex {
	private readonly tails = new Map<string, Promise<void>>();

	async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
		const previous = this.tails.get(key) ?? Promise.resolve();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tail = this.chain(previous, gate);
		this.tails.set(key, tail);

		await swallow(previous);
		try {
			return await fn();
		} finally {
			release();
			if (this.tails.get(key) === tail) this.tails.delete(key);
		}
	}

	private async chain(previous: Promise<void>, gate: Promise<void>): Promise<void> {
		await swallow(previous);
		await gate;
	}

	/**
	 * Drops the queued tail for `key` (e.g. the keyed resource ended): callers
	 * that already captured the tail still settle in order, while the next
	 * caller starts immediately instead of waiting on it.
	 */
	forget(key: string): void {
		this.tails.delete(key);
	}
}

/** A failed earlier section must not skip or reject every later section. */
async function swallow(promise: Promise<void>): Promise<void> {
	try {
		await promise;
	} catch {
		// Intentionally ignored — the previous holder's failure is not ours.
	}
}

/**
 * Coalesces concurrent calls for the same key: while a call is in flight,
 * every other caller for that key awaits the same promise instead of starting
 * a duplicate. The entry is dropped as soon as the call settles.
 */
export class InFlightMap<T> {
	private readonly inFlight = new Map<string, Promise<T>>();

	async run(key: string, task: () => Promise<T>): Promise<T> {
		const pending = this.inFlight.get(key);
		if (pending) return await pending;

		const started = task();
		this.inFlight.set(key, started);
		try {
			return await started;
		} finally {
			if (this.inFlight.get(key) === started) this.inFlight.delete(key);
		}
	}

	/** The in-flight promise for `key`, or undefined — lets a caller await settlement without starting work. */
	peek(key: string): Promise<T> | undefined {
		return this.inFlight.get(key);
	}
}
