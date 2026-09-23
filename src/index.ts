import cors from "@elysiajs/cors";
import serverTiming from "@elysiajs/server-timing";
import Elysia from "elysia";
import { apiRouter } from "./api/routes";
import { systemSettingsService } from "./application/admin/system-settings.service";
import { firstRunSetupService } from "./application/auth/setup/first-run-setup.service";
import { libraryWatcherService } from "./application/libraries/watching/library-watcher.service";
import { pluginsService } from "./application/plugins.service";
import { databaseFactory } from "./database/database";
import { env } from "./env";
import { initializeFfmpegCapabilities, missingAudioFilters } from "./integrations/ffmpeg/ffmpeg.capabilities";
import { assertFFMpegAvailable } from "./integrations/ffmpeg/ffmpeg.environment";
import { assertFFProbeAvailable } from "./integrations/ffprobe/ffprobe.environment";
import { clientIpMiddleware } from "./middleware/client-ip.middleware";
import { compressionMiddleware } from "./middleware/compression.middleware";
import { domainErrorsMiddleware } from "./middleware/domain-errors.middleware";
import { openapiMiddleware } from "./middleware/openapi.middleware";
import { rateLimitMiddleware } from "./middleware/rate-limit.middleware";
import { requestDedupMiddleware } from "./middleware/request-dedup.middleware";
import { requestLoggerMiddleware } from "./middleware/request-logger.middleware";
import { requestTimeoutMiddleware } from "./middleware/request-timeout.middleware";
import { responseCacheMiddleware } from "./middleware/response-cache.middleware";
import { securityHeadersMiddleware } from "./middleware/security.middleware";
import { serverConfig } from "./server.config";
import { Shutdown } from "./shutdown";
import { resourceAllocator } from "./system/resource-allocator";
import { serverRescueService } from "./system/server-rescue.service";
import { systemResourcesService } from "./system/system-resources.service";
import { isOriginAllowed } from "./utils/http.utils";
import { logger } from "./utils/logger";
import { cleanupStartupDirectories, ensureDataDirectories } from "./utils/server-data.utils";
import { webStaticPlugin } from "./web/web-static.plugin";
import { loadBuiltInWorkers } from "./workers/built-in-workers";
import { scheduledTasksService } from "./workers/scheduled-tasks.service";
import { workerService } from "./workers/worker.service";

async function setupServer(): Promise<void> {
	try {
		logger.info("Checking directories and files...");
		await ensureDataDirectories();
		await cleanupStartupDirectories();

		// Apply pending schema migrations before any repository touches the DB.
		logger.info("Applying database migrations...");
		const { applied } = databaseFactory.migrate();
		logger.info("Database migrations applied", { appliedMigrations: applied });

		logger.info("Loading system settings...");
		await systemSettingsService.init();

		logger.info("Checking FFmpeg and FFprobe dependencies...");
		const ffMpegAvailable = assertFFMpegAvailable();
		const ffMpegCapabilities = await initializeFfmpegCapabilities();
		const ffProbeAvailable = assertFFProbeAvailable();
		logger.info("FFmpeg dependencies available", {
			ffMpeg: ffMpegAvailable,
			ffProbe: ffProbeAvailable,
			ffMpegVersion: ffMpegCapabilities.version,
			missingAudioFilters: missingAudioFilters(),
		});

		await firstRunSetupService.getStatus();

		logger.info("Loading plugins...");
		await pluginsService.load();

		logger.info("Loading queue service...");
		const builtInWorkers = await loadBuiltInWorkers();
		await workerService.initialize(builtInWorkers);

		await scheduledTasksService.init();

		logger.info("Initializing resource allocator...");
		await resourceAllocator.initialize();

		// Arm the server rescue monitor (event-loop lag + system pressure watchdog)
		serverRescueService.registerPressureProvider(() => resourceAllocator.getCurrentSnapshot()?.pressure ?? "low");
		serverRescueService.registerSpeedFactorProvider(() => systemResourcesService.getSpeedFactor());
		serverRescueService.init();

		logger.info("Initializing library watchers...");
		await libraryWatcherService.init();
	} catch (error) {
		logger.error("Failed to start server", error);
		process.exit(1);
	}
}
await setupServer();

// Setup Elysia — domainErrorsMiddleware catches DomainError subclasses and maps
// them to structured API responses (400/401/403/404/409/408/429/500).
const app = new Elysia({ name: "ReelVault", aot: true })
	.use(domainErrorsMiddleware)
	// Tracing closures + Server-Timing header on every request — dev diagnostics only.
	.use(serverTiming({ enabled: env.NODE_ENV === "development" }))
	.use(securityHeadersMiddleware)
	.use(requestLoggerMiddleware)
	.use(requestDedupMiddleware)
	.use(responseCacheMiddleware)
	.use(compressionMiddleware)
	.use(
		cors({
			origin: (request) => isOriginAllowed(request.headers.get("origin")),
			methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
			credentials: true,
			allowedHeaders: [
				"Content-Type",
				"Authorization",
				"Idempotency-Key",
				"x-requested-with",
				"x-profile-id",
				"x-setup-token",
				"x-client-shell",
			],
			// Browser clients need explicit access to these non-simple response headers.
			exposeHeaders: ["ETag", "X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset"],
		}),
	)
	// Public API reference; OPENAPI_DOCS_ENABLED=false unregisters it entirely.
	.use(openapiMiddleware)
	// Must precede every consumer of the client IP (rate limiter, auth, audit).
	.use(clientIpMiddleware)
	.use(rateLimitMiddleware)
	.use(requestTimeoutMiddleware)
	.use(apiRouter)
	// After the API router: the wildcard serves the bundled web UI without ever
	// shadowing /v1 or /openapi (API paths yield to keep the JSON 404 envelope).
	.use(webStaticPlugin);

// Setup graceful shutdown
const shutdownHandler = new Shutdown({ shutdownAppFn: () => app.stop() });
shutdownHandler.init();

// Start the server
app.listen(
	{
		port: env.APP_PORT,
		hostname: serverConfig.network.host,
		maxRequestBodySize: 50 * 1024 * 1024,
		// Bun's default (10s) kills idle sockets mid-request — the playlist endpoint
		// legitimately blocks server-side for up to ~60s on slow storage while ffmpeg
		// produces the first manifest, which the client saw as an empty failed response.
		idleTimeout: 255, // seconds — Bun's maximum
	},
	() => {
		logger.info(`🚀 Server started successfully`, {
			port: env.APP_PORT,
			host: serverConfig.network.host,
			environment: env.NODE_ENV,
			database: serverConfig.paths.sqlite,
		});
	},
);
