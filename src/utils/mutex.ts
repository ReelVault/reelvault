/** Per-key serialisation — different keys still run concurrently. */
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
}

/** Single shared key — `Mutex` is the global (unkeyed) case of `KeyedMutex`. */
const GLOBAL_MUTEX_KEY = "__global__";

/**
 * Serialises async critical sections. Plugin lifecycle operations (install,
 * upgrade, reload, enable/disable, uninstall) mutate the same on-disk
 * directories, lockfile and registry, so concurrent admin requests must not
 * interleave them.
 */
export class Mutex {
	private readonly inner = new KeyedMutex();

	async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
		return await this.inner.runExclusive(GLOBAL_MUTEX_KEY, fn);
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
