import { gc } from "bun";

export class BatchGarbageCollector {
	private count = 0;
	private readonly interval: number;

	constructor(interval = 25) {
		this.interval = interval;
	}

	tick(): void {
		if (++this.count >= this.interval) {
			this.count = 0;
			// Defer GC off the synchronous processing path to avoid Stop-The-World
			// pauses on the event loop. Same pattern as worker-execution-pool.ts.
			setTimeout(() => gc(false), 0).unref();
		}
	}
}
