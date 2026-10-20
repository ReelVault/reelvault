import cors from "@elysiajs/cors";
import Elysia from "elysia";
import { MIB } from "@/utils/bytes.utils";
import { systemSettingsService } from "./app/admin/system-settings.service";
import { firstRunSetupService } from "./app/auth/setup/first-run-setup.service";
import { clientIpMiddleware } from "./app/http/middleware/client-ip.middleware";
import { compressionMiddleware } from "./app/http/middleware/compression.middleware";
import { domainErrorsMiddleware } from "./app/http/middleware/domain-errors.middleware";
import { openapiMiddleware } from "./app/http/middleware/openapi.middleware";
import { rateLimitMiddleware } from "./app/http/middleware/rate-limit.middleware";
import { requestDedupMiddleware } from "./app/http/middleware/request-dedup.middleware";
import { requestLoggerMiddleware } from "./app/http/middleware/request-logger.middleware";
import { responseCacheMiddleware } from "./app/http/middleware/response-cache.middleware";
import { securityHeadersMiddleware } from "./app/http/middleware/security.middleware";
import { apiRouter } from "./app/http/routes/api.routes";
import { webStaticPlugin } from "./app/http/web/web-static.plugin";
import { libraryWatcherService } from "./app/libraries/watching/library-watcher.service";
import { notificationsService } from "./app/notifications/notifications.service";
import { scheduleStartupUpdateCheck } from "./app/updates/update-check.service";
import { updateHistoryService } from "./app/updates/update-history.service";
import { updateInstallService } from "./app/updates/update-install.service";
import { wireIntegrationPorts } from "./app/wiring/integration-ports";
import { wireModulePorts } from "./app/wiring/module-ports";
import { wireSystemPorts } from "./app/wiring/system-ports";
import { wireWorkerPorts } from "./app/wiring/worker-ports";
import { env } from "./config/env.config";
import { serverConfig } from "./config/server/server.config";
import { RECOMMENDED_FFMPEG_MAJOR } from "./config/server/server.constants";
import { systemResourcesService } from "./config/system-resources.service";
import { SERVER_VERSION } from "./config/version.constants";
import { databaseFactory } from "./integrations/drizzle-orm/database.factory";
import { initializeFfmpegCapabilities, missingAudioFilters } from "./integrations/ffmpeg/ffmpeg.capabilities";
import { assertFFMpegAvailable } from "./integrations/ffmpeg/ffmpeg.environment";
import { assertFFProbeAvailable } from "./integrations/ffprobe/ffprobe.environment";
import { downloadsService } from "./modules/downloads/downloads.service";
import { registerStreamingLifecycle } from "./modules/streaming/runtime/streaming.runtime";
import { registerPluginNotificationSink } from "./plugins/lifecycle/host/plugin-host.factory";
import { pluginManager } from "./plugins/lifecycle/plugin.manager";
import { resourceAllocator } from "./system/resource-allocator.service";
import { cleanupStartupDirectories, ensureDataDirectories } from "./system/server-data.utils";
import { serverRescueService } from "./system/server-rescue.service";
import { Shutdown, setActiveShutdown } from "./system/shutdown.service";
import { flushLogs, logger, setLogLevel } from "./utils/logger.utils";
import { isOriginAllowed, isUsableOriginEntry } from "./utils/origin-trust.utils";
import { loadBuiltInWorkers } from "./workers/built-in.loader";
import { workerService } from "./workers/worker.service";

/** Matches the leading major of FFmpeg versions like `7.0.2`, `6.1.1-3ubuntu5` or `n7.0`. */
const FFMPEG_MAJOR_VERSION_REGEX = /^n?(\d+)/;

/** Wildcard binds are reachable from any network the host is on. */
const PUBLIC_BIND_HOSTS: ReadonlySet<string> = new Set(["0.0.0.0", "::", "*"]);

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

		// Modules read their data through ports; wire them before any module runs.
		wireModulePorts();
		// Workers take their stores the same way, before the scheduler or any pool starts.
		wireWorkerPorts();
		wireSystemPorts();
		// Auth and provider sync write through app repositories, so they are wired before any user or provider write.
		wireIntegrationPorts();

		// Runs left open by the previous process: a server run that restarted into its target version succeeded.
		await updateHistoryService.settleRunsAfterStart(SERVER_VERSION);

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
		registerPluginNotificationSink({
			create: async (notification, options) => await notificationsService.create(notification, options),
			createForAdministrators: async (notification, options) => await notificationsService.createForAdministrators(notification, options),
		});

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
		await flushLogs();
		process.exit(1);
	}
}
await setupServer();

// Setup Elysia — domainErrorsMiddleware catches DomainError subclasses and maps
// them to structured API responses (400/401/403/404/409/408/429/500).
//
// encodeSchema: false skips Elysia's response-transform encoding. SDK entity
// schemas carry `t.Date()` transforms, and running them over every uncached
// payload costs CPU. `JSON.stringify` writes a Date as the same ISO string the
// transform produces. Response validation and unknown-field stripping still run.
// One difference: a number in a Date field now passes the response check and is
// served as a number, where it used to fail with a 422. The response-cache hit
// path has always served pre-serialized bodies without the transform.
const app = new Elysia({ name: "ReelVault", aot: true, encodeSchema: false })
	.use(domainErrorsMiddleware)
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
			maxRequestBodySize: 50 * MIB,
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
		await flushLogs();
		process.exit(1);
	}

	throw error;
}

/** Bun reports a taken port as `EADDRINUSE` on the error or in its message. */
function isAddressInUse(error: unknown): boolean {
	if (!(error instanceof Error)) return false;

	return Reflect.get(error, "code") === "EADDRINUSE" || error.message.includes("EADDRINUSE") || error.message.includes("in use");
}

function isPublicBindHost(host: string): boolean {
	return PUBLIC_BIND_HOSTS.has(host);
}

/** Unknown version strings return null — a warning would be noise. */
function parseMajorVersion(version: string): number | null {
	const match = FFMPEG_MAJOR_VERSION_REGEX.exec(version);
	if (!match?.[1]) return null;

	return Number.parseInt(match[1], 10);
}
