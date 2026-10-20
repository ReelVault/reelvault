import { detach } from "@/utils/promise.utils";

/**
 * One `.unref()`-ed interval with an explicit start/stop lifecycle. Replaces the
 * hand-managed timer fields in the supervisors: double-start is a no-op, the
 * handle is always cleared on stop, and an async callback's rejection is routed
 * to `onError` instead of becoming an unhandled rejection.
 */
export class RecurringTimer {
	private handle: ReturnType<typeof setInterval> | undefined;
	private readonly run: () => void | Promise<void>;
	private readonly intervalMs: number;
	private readonly onError: ((error: unknown) => void) | undefined;

	constructor(run: () => void | Promise<void>, intervalMs: number, onError?: (error: unknown) => void) {
		this.run = run;
		this.intervalMs = intervalMs;
		this.onError = onError;
	}

	get running(): boolean {
		return this.handle !== undefined;
	}

	start(): void {
		if (this.handle) return;

		this.handle = setInterval(() => {
			detach(this.runSafely());
		}, this.intervalMs);
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
		if (!this.handle) return;

		clearInterval(this.handle);
		this.handle = undefined;
	}
}
