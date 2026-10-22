import { serverConfig } from "@/config/server/server.config";
import { flushLogs, logger } from "@/utils/logger.utils";
import { detach } from "@/utils/promise.utils";

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
		// database open or the logs unflushed.
		let failedSteps = 0;
		for (const step of this.steps) {
			logger.info(step.message);
			try {
				await step.run();
			} catch (error) {
				failedSteps++;
				logger.error("Shutdown step failed", error, { step: step.name });
			}
		}

		if (failedSteps === 0) logger.info("✅ Graceful shutdown completed");
		else logger.error("Graceful shutdown finished with failed steps", undefined, { failedSteps });

		// Flush before clearing the timeout: if the disk stalls, the timeout still forces the exit.
		await flushLogs();
		clearTimeout(this.shutdownTimeout);
		process.exit(failedSteps === 0 ? 0 : 1);
	}
}
