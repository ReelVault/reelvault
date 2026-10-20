import { serverConfig } from "@/config/server/server.config";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { ffMpegService } from "@/integrations/ffmpeg/ffmpeg.service";
import { flushLogs, logger } from "@/utils/logger.utils";
import { detach } from "@/utils/promise.utils";
import { resourceAllocator } from "./resource-allocator.service";
import { serverRescueService } from "./server-rescue.service";
import { systemShutdown } from "./system.ports";

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

/** One stop step. Steps run in array order, so the order below is the shutdown order. */
interface ShutdownStep {
	readonly name: string;
	readonly message: string;
	readonly run: () => unknown;
}

/**
 * Graceful shutdown handler
 * Prevents data loss and ensures clean exit
 */
export class Shutdown {
	private readonly shutdownAppFn: () => unknown;

	private isShuttingDown = false;
	private shutdownTimeout?: Timer | undefined;

	constructor({ shutdownAppFn }: { shutdownAppFn: () => unknown }) {
		this.shutdownAppFn = shutdownAppFn;
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

	/**
	 * The order matters: intake stops first, background work next, queues and
	 * streams after that, and the database closes last, once nothing writes to it.
	 */
	private steps(): ShutdownStep[] {
		return [
			// Realtime first: app.stop() waits for open sockets to drain, and a
			// connected events WebSocket never closes on its own — stopping the
			// server before telling clients to go away deadlocked shutdown until
			// the 30s timeout. Closing them first lets stop() (and the graceful
			// path) actually complete.
			{ name: "realtime", message: "Closing realtime connections...", run: () => systemShutdown().closeRealtime() },
			{ name: "http", message: "Stopping server...", run: () => this.shutdownAppFn() },
			{ name: "library-watchers", message: "Stopping library watchers...", run: () => systemShutdown().stopLibraryWatchers() },
			{ name: "resource-allocator", message: "Shutting down resource allocator...", run: () => resourceAllocator.shutdown() },
			{ name: "server-rescue", message: "Stopping server rescue monitor...", run: () => serverRescueService.shutdown() },
			{ name: "workers", message: "Shutting down queue system...", run: () => systemShutdown().stopWorkers() },
			// Retention sweeps query the database, so they stop before it closes.
			{ name: "download-sweeps", message: "Stopping download retention sweeps...", run: () => systemShutdown().stopDownloadSweeps() },
			{ name: "streaming", message: "Closing streaming sessions...", run: () => systemShutdown().closeStreaming() },
			{ name: "ffmpeg", message: "Terminating FFmpeg processes...", run: () => ffMpegService.killAll() },
			// Plugins get their onDisable/onUnload/dispose while the database is
			// still open; each unload is individually time-boxed inside.
			{ name: "plugins", message: "Unloading plugins...", run: () => systemShutdown().unloadPlugins() },
			{ name: "database", message: "Closing database...", run: () => databaseFactory.shutdown() },
		];
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
		for (const step of this.steps()) {
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
