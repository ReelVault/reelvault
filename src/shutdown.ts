import { streamingService } from "@/modules/streaming/runtime/streaming.manager";
import { libraryWatcherService } from "./application/libraries/watching/library-watcher.service";
import { pluginsService } from "./application/plugins.service";
import { databaseFactory } from "./database/database";
import { ffMpegService } from "./integrations/ffmpeg/ffmpeg.service";
import { realtimeService } from "./modules/realtime";
import { serverConfig } from "./server.config";
import { resourceAllocator } from "./system/resource-allocator";
import { serverRescueService } from "./system/server-rescue.service";
import { logger } from "./utils/logger";
import { detach } from "./utils/promise.utils";
import { workerService } from "./workers/worker.service";

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

		try {
			// Realtime first: app.stop() waits for open sockets to drain, and a
			// connected events WebSocket never closes on its own — stopping the
			// server before telling clients to go away deadlocked shutdown until
			// the 30s timeout. Closing them first lets stop() (and the graceful
			// path) actually complete.
			logger.info("Closing realtime connections...");
			realtimeService.shutdown();

			logger.info("Stopping server...");
			await this.shutdownAppFn();

			logger.info("Stopping library watchers...");
			libraryWatcherService.shutdown();

			logger.info("Shutting down resource allocator...");
			await resourceAllocator.shutdown();
			serverRescueService.shutdown();

			logger.info("Shutting down queue system...");
			await workerService.shutdown();

			logger.info("Closing streaming sessions...");
			await streamingService.shutdown();
			ffMpegService.killAll();

			// Plugins get their onDisable/onUnload/dispose while the database is
			// still open; each unload is individually time-boxed inside.
			logger.info("Unloading plugins...");
			await pluginsService.shutdown();

			logger.info("Closing database...");
			databaseFactory.shutdown();

			logger.info("✅ Graceful shutdown completed");

			clearTimeout(this.shutdownTimeout);
			process.exit(0);
		} catch (error) {
			logger.error("Error during shutdown", error);
			process.exit(1);
		}
	}
}
