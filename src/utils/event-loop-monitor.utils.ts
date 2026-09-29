/**
 * Event-loop utilization with Node's `performance.eventLoopUtilization`
 * semantics: utilization = active / (active + idle) over the window between
 * two reads, where "active" is the time the loop was blocked past its sampling
 * cadence. Bun does not ship eventLoopUtilization, so this measures it with a
 * probe timer — loop stalls surface as probe delays.
 */
export class EventLoopMonitor {
	private readonly intervalMs: number;
	private lastAt = 0;
	private delayedMs = 0;
	private elapsedMs = 0;
	private readonly timer: ReturnType<typeof setInterval>;

	constructor(intervalMs = 100) {
		this.intervalMs = intervalMs;
		this.lastAt = Date.now();
		this.timer = setInterval(() => this.tick(), intervalMs);
		this.timer.unref();
	}

	private tick(): void {
		const now = Date.now();
		const expected = this.lastAt + this.intervalMs;
		const delayed = now - expected;
		if (delayed > 0) this.delayedMs += delayed;
		this.elapsedMs += now - this.lastAt;
		this.lastAt = now;
	}

	/** Utilization in [0, 1] since the previous read; undefined on the first read. */
	read(): number | undefined {
		if (this.elapsedMs <= 0) return undefined;

		const utilization = this.delayedMs / this.elapsedMs;
		this.delayedMs = 0;
		this.elapsedMs = 0;

		return Math.min(1, Math.max(0, utilization));
	}

	stop(): void {
		clearInterval(this.timer);
	}
}
