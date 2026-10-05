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
}
