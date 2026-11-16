import { detach } from "@/utils/promise.utils";

/**
 * One `.unref()`-ed recurring task with an explicit start/stop lifecycle.
 * A self-rescheduling `setTimeout` (instead of `setInterval`) means a slow
 * callback never overlaps the next tick, and a function interval can follow a
 * runtime setting without rebuilding the timer.
 */
export class RecurringTimer {
	private handle: ReturnType<typeof setTimeout> | undefined;
	private readonly run: () => void | Promise<void>;
	private readonly intervalMs: number | (() => number);
	private readonly onError: ((error: unknown) => void) | undefined;
	private stopped = true;
	/** A stop/start cycle during an in-flight tick must not let the old chain reschedule itself. */
	private generation = 0;

	constructor(run: () => void | Promise<void>, intervalMs: number | (() => number), onError?: (error: unknown) => void) {
		this.run = run;
		this.intervalMs = intervalMs;
		this.onError = onError;
	}

	get running(): boolean {
		return !this.stopped;
	}

	start(): void {
		if (!this.stopped) return;

		this.stopped = false;
		this.generation++;
		this.scheduleNext();
	}

	private scheduleNext(): void {
		if (this.stopped) return;

		const generation = this.generation;
		const delayMs = typeof this.intervalMs === "function" ? this.intervalMs() : this.intervalMs;
		this.handle = setTimeout(() => {
			this.handle = undefined;
			if (generation !== this.generation || this.stopped) return;
			detach(
				(async () => {
					await this.runSafely();
					if (generation === this.generation && !this.stopped) this.scheduleNext();
				})(),
			);
		}, delayMs);
		this.handle.unref();
	}

	private async runSafely(): Promise<void> {
		try {
			await this.run();
		} catch (error) {
			this.onError?.(error);
		}
	}

	stop(): void {
		if (this.stopped) return;

		this.stopped = true;
		this.generation++;
		if (this.handle) {
			clearTimeout(this.handle);
			this.handle = undefined;
		}
	}
}
