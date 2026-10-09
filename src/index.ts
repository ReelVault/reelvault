import cors from "@elysiajs/cors";
import serverTiming from "@elysiajs/server-timing";
import Elysia from "elysia";
import { apiRouter } from "./api/routes";
import { systemSettingsService } from "./application/admin/system-settings.service";
import { firstRunSetupService } from "./application/auth/setup/first-run-setup.service";
import { libraryWatcherService } from "./application/libraries/watching/library-watcher.service";
import { scheduleStartupUpdateCheck } from "./application/updates/update-check.service";
import { updateInstallService } from "./application/updates/update-install.service";
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
import { responseCacheMiddleware } from "./middleware/response-cache.middleware";
import { securityHeadersMiddleware } from "./middleware/security.middleware";
import { downloadsService } from "./modules/downloads/downloads.service";
import { registerStreamingLifecycle } from "./modules/streaming/runtime/streaming.runtime";
import { pluginManager } from "./plugins/lifecycle/plugin.manager";
import { serverConfig } from "./server.config";
import { RECOMMENDED_FFMPEG_MAJOR } from "./server.constants";
import { Shutdown, setActiveShutdown } from "./shutdown";
import { resourceAllocator } from "./system/resource-allocator";
import { serverRescueService } from "./system/server-rescue.service";
import { systemResourcesService } from "./system/system-resources.service";
import { isOriginAllowed, isUsableOriginEntry } from "./utils/http.utils";
import { logger, setLogLevel } from "./utils/logger";
import { cleanupStartupDirectories, ensureDataDirectories } from "./utils/server-data.utils";
import { webStaticPlugin } from "./web/web-static.plugin";
import { loadBuiltInWorkers } from "./workers/built-in-workers";
import { scheduledTasksService } from "./workers/scheduled-tasks.service";
import { workerService } from "./workers/worker.service";

/** Matches the leading major of FFmpeg versions like `7.0.2`, `6.1.1-3ubuntu5` or `n7.0`. */
const FFMPEG_MAJOR_VERSION_REGEX = /^n?(\d+)/;

async function setupServer(): Promise<void> {
	try {
		logger.info("Checking directories and files...");
		await ensureDataDirectories();
		await cleanupStartupDirectories();
		updateInstallService.cleanupStaleArtifacts();

		// Apply pending schema migrations before any repository touches the DB.
		logger.info("Applying database migrations...");
		const { applied } = databaseFactory.migrate();
		logger.info("Database migrations applied", { appliedMigrations: applied });

		logger.info("Loading system settings...");
		await systemSettingsService.init();
		// A stored override replaces the LOG_LEVEL this boot started with; the debug file still requires restart.
		setLogLevel(serverConfig.logs.level);

		// A typo in an allowed-origin entry would otherwise fail silently at CORS time.
		const unusableOrigins = serverConfig.network.allowedOrigins.filter((origin) => !isUsableOriginEntry(origin));
		if (unusableOrigins.length > 0) logger.warn("Ignoring unusable allowed-origin entries", { entries: unusableOrigins });

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

		const ffMpegMajor = parseMajorVersion(ffMpegCapabilities.version);
		if (ffMpegMajor !== null && ffMpegMajor < RECOMMENDED_FFMPEG_MAJOR) {
			logger.warn(
				`FFmpeg ${ffMpegCapabilities.version} is older than the recommended ${RECOMMENDED_FFMPEG_MAJOR}.x — HDR tone mapping and newer encoders may be unavailable`,
			);
		}

		const setupStatus = await firstRunSetupService.getStatus();
		if (setupStatus.required && !setupStatus.tokenRequired && isPublicBindHost(serverConfig.network.host)) {
			logger.warn(
				`First-run setup is still pending and the server is bound to ${serverConfig.network.host} without a setup token — anyone who can reach it can create the first administrator. Set SETUP_TOKEN_ENABLED=true before exposing it.`,
			);
		}

		logger.info("Loading plugins...");
		await pluginManager.loadPlugins();

		logger.info("Loading queue service...");
		const builtInWorkers = await loadBuiltInWorkers();
		await workerService.initialize(builtInWorkers);

		// Downloads interrupted by a crash would otherwise pin their profile's only
		// active-download slot forever; re-check and re-enqueue them.
		try {
			const requeuedDownloads = await downloadsService.reconcileOnStartup();
			if (requeuedDownloads > 0) logger.info("Reconciled interrupted downloads", { requeued: requeuedDownloads });
		} catch (error) {
			logger.warn("Download reconciliation failed", { error });
		}

		// Streaming lifecycle callbacks must be configured before any session can start.
		registerStreamingLifecycle();

		await scheduledTasksService.init();

		logger.info("Initializing resource allocator...");
		await resourceAllocator.initialize();

		// Arm the server rescue monitor (event-loop lag + system pressure watchdog)
		serverRescueService.registerPressureProvider(() => resourceAllocator.getCurrentSnapshot()?.pressure ?? "low");
		serverRescueService.registerSpeedFactorProvider(() => systemResourcesService.getSpeedFactor());
		serverRescueService.init();

		logger.info("Initializing library watchers...");
		await libraryWatcherService.init();

		// Fire-and-forget: a slow or unreachable GitHub must never delay boot.
		scheduleStartupUpdateCheck();
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
				"x-api-key",
				"x-client-shell",
			],
			// Browser clients need explicit access to these non-simple response headers.
			exposeHeaders: ["ETag", "Retry-After", "X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset"],
		}),
	)
	// Public API reference; OPENAPI_DOCS_ENABLED=false unregisters it entirely.
	.use(openapiMiddleware)
	// Must precede every consumer of the client IP (rate limiter, auth, audit).
	.use(clientIpMiddleware)
	.use(rateLimitMiddleware)
	.use(apiRouter)
	// After the API router: the wildcard serves the bundled web UI without ever
	// shadowing /v1 or /openapi (API paths yield to keep the JSON 404 envelope).
	.use(webStaticPlugin);

// Setup graceful shutdown
const shutdownHandler = new Shutdown({ shutdownAppFn: () => app.stop() });
setActiveShutdown(shutdownHandler);
shutdownHandler.init();

// Start the server
try {
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
} catch (error) {
	// A taken port is the most common first-run failure — say how to fix it instead of dumping a stack.
	if (isAddressInUse(error)) {
		logger.fatal(
			`Port ${env.APP_PORT} is already in use on ${serverConfig.network.host}. Stop the other process or set APP_PORT to a free port.`,
		);
		process.exit(1);
	}

	throw error;
}

/** Bun reports a taken port as `EADDRINUSE` on the error or in its message. */
function isAddressInUse(error: unknown): boolean {
	if (!(error instanceof Error)) return false;

	return Reflect.get(error, "code") === "EADDRINUSE" || error.message.includes("EADDRINUSE") || error.message.includes("in use");
}

/** Wildcard binds are reachable from any network the host is on. */
const PUBLIC_BIND_HOSTS: ReadonlySet<string> = new Set(["0.0.0.0", "::", "*"]);

function isPublicBindHost(host: string): boolean {
	return PUBLIC_BIND_HOSTS.has(host);
}

/** Unknown version strings return null — a warning would be noise. */
function parseMajorVersion(version: string): number | null {
	const match = version.match(FFMPEG_MAJOR_VERSION_REGEX);
	if (!match?.[1]) return null;

	return Number.parseInt(match[1], 10);
}
