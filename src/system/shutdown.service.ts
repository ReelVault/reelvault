import { serverConfig } from "@/config/server/server.config";
import { flushLogs, logger } from "@/utils/logger.utils";
import { detach, PromiseTimeoutError, withTimeout } from "@/utils/promise.utils";

/** Default budget for one stop step; a later step must still get its turn. */
const DEFAULT_STEP_TIMEOUT_MS = 5_000;

/** Registered by index.ts once the real server is wired up. */
let activeShutdownHandler: Shutdown | undefined;

/**
 * Triggers the graceful shutdown path from application code (self-update
 * restart). Returns false when no handler is registered (tests, early boot).
 */
export function requestApplicationRestart(): boolean {
	if (!activeShutdownHandler) return false;

	const run = async (): Promise<void> => {
		try {
			await activeShutdownHandler?.shutdown("update-restart");
		} catch {
			// shutdown() already logs its own failures
		}
	};
	detach(run());

	return true;
}

/** Points `requestApplicationRestart` at the live Shutdown instance. */
export function setActiveShutdown(handler: Shutdown): void {
	activeShutdownHandler = handler;
}

/** One stop step. Steps run in array order, so the array the composition root passes is the shutdown order. */
export interface ShutdownStep {
	readonly name: string;
	readonly message: string;
	readonly run: () => unknown;
	/** Per-step budget; the global shutdown timer is the last resort, not the first. */
	readonly timeoutMs?: number | undefined;
	/** Best-effort forceful fallback when the step misses its budget (e.g. abrupt HTTP stop). */
	readonly onTimeout?: (() => unknown) | undefined;
}

/**
 * Graceful shutdown: runs the stop steps in order on SIGTERM/SIGINT, a fatal
 * error or a self-update restart, and exits once they are done or the timeout hits.
 */
export class Shutdown {
	private readonly steps: readonly ShutdownStep[];

	private isShuttingDown = false;
	private shutdownTimeout?: Timer | undefined;

	constructor(steps: readonly ShutdownStep[]) {
		this.steps = steps;
	}

	init() {
		const onSignal = (signal: string): void => {
			const runShutdown = async (): Promise<void> => {
				try {
					// A second Ctrl+C or SIGTERM during the graceful path means the operator wants out now.
					if (this.isShuttingDown && (signal === "SIGINT" || signal === "SIGTERM")) {
						logger.warn("Repeated shutdown signal, forcing exit", { signal });
						await flushLogs();
						process.exit(1);
					}

					await this.shutdown(signal);
				} catch (error) {
					logger.error("Shutdown failed", error);
				}
			};
			detach(runShutdown());
		};
		process.on("SIGTERM", () => onSignal("SIGTERM"));
		process.on("SIGINT", () => onSignal("SIGINT"));

		process.on("uncaughtException", (error) => {
			logger.error("Uncaught exception", error);
			onSignal("uncaughtException");
		});

		process.on("unhandledRejection", (reason, promise) => {
			logger.error("Unhandled rejection", reason, { hasPromise: Boolean(promise) });
		});
	}

	/** One step with its own deadline; returns false when it failed or timed out. */
	private async runStep(step: ShutdownStep): Promise<boolean> {
		logger.info(step.message);
		const timeoutMs = step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;

		try {
			await withTimeout(Promise.resolve(step.run()), timeoutMs, `shutdown step ${step.name}`);

			return true;
		} catch (error) {
			await this.reportStepFailure(step, error, timeoutMs);

			return false;
		}
	}

	private async reportStepFailure(step: ShutdownStep, error: unknown, timeoutMs: number): Promise<void> {
		if (!(error instanceof PromiseTimeoutError)) {
			logger.error("Shutdown step failed", error, { step: step.name });

			return;
		}

		logger.error("Shutdown step timed out", error, { step: step.name, timeoutMs });
		if (!step.onTimeout) return;

		try {
			await withTimeout(Promise.resolve(step.onTimeout()), DEFAULT_STEP_TIMEOUT_MS, `shutdown step ${step.name} fallback`);
		} catch (fallbackError) {
			logger.error("Shutdown step fallback failed", fallbackError, { step: step.name });
		}
	}

	async shutdown(signal: string): Promise<void> {
		if (this.isShuttingDown) {
			logger.warn("Shutdown already in progress");

			return;
		}

		this.isShuttingDown = true;
		logger.info("Received shutdown signal", { signal });

		this.shutdownTimeout = setTimeout(() => {
			logger.error("Graceful shutdown timed out, forcing exit", undefined, { timeoutMs: serverConfig.shutdown.timeoutMs });
			process.exit(1);
		}, serverConfig.shutdown.timeoutMs);

		// A failing step is logged and skipped, so one broken service cannot keep the
		// database open or the logs unflushed. Each step has its own budget: a slow
		// HTTP drain must not consume the whole shutdown window and skip FFmpeg,
		// plugins and the database close.
		let failedSteps = 0;
		for (const step of this.steps) {
			if (!(await this.runStep(step))) failedSteps++;
		}

		if (failedSteps === 0) logger.info("✅ Graceful shutdown completed");
		else logger.error("Graceful shutdown finished with failed steps", undefined, { failedSteps });

		// Flush before clearing the timeout: if the disk stalls, the timeout still forces the exit.
		await flushLogs();
		clearTimeout(this.shutdownTimeout);
		process.exit(failedSteps === 0 ? 0 : 1);
	}
}
