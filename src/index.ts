import { MIB } from "@/utils/bytes.utils";
import { createHttpApp } from "./api/http-app.factory";
import { env } from "./config/env.config";
import { serverConfig } from "./config/server/server.config";
import { RECOMMENDED_FFMPEG_MAJOR } from "./config/server/server.constants";
import { systemResourcesService } from "./config/system-resources.service";
import { SERVER_VERSION } from "./config/version.constants";
import { databaseFactory } from "./integrations/drizzle-orm/database.factory";
import { initializeFfmpegCapabilities, missingAudioFilters } from "./integrations/ffmpeg/ffmpeg.capabilities";
import { assertFFMpegAvailable } from "./integrations/ffmpeg/ffmpeg.environment";
import { ffMpegService } from "./integrations/ffmpeg/ffmpeg.service";
import { assertFFProbeAvailable } from "./integrations/ffprobe/ffprobe.environment";
import { downloadsService } from "./modules/downloads/downloads.service";
import { realtimeService } from "./modules/realtime/realtime.service";
import { streamingManager } from "./modules/streaming/runtime/streaming.manager";
import { registerStreamingLifecycle } from "./modules/streaming/runtime/streaming.runtime";
import { pluginManager } from "./plugins/lifecycle/plugin.manager";
import { onNotificationChannelFailure } from "./plugins/runtime/notification-channel.registry";
import { hasCatalogMediaStats, rebuildMediaStats } from "./repositories/media-stats.repository";
import { backfillLatestMediaCreatedAt } from "./repositories/metadata/media-presence.writer";
import { adminFailureNotificationService } from "./services/admin/admin-failure-notification.service";
import { systemSettingsService } from "./services/admin/system-settings.service";
import { registerAuthListeners } from "./services/auth/auth.service";
import { firstRunSetupService } from "./services/auth/setup/first-run-setup.service";
import { librariesService } from "./services/libraries/libraries.service";
import { libraryWatcherService } from "./services/libraries/watching/library-watcher.service";
import { reportChannelFailureToAdministrators } from "./services/notifications/notifications.service";
import { scheduleStartupUpdateCheck } from "./services/updates/update-check.service";
import { updateHistoryService } from "./services/updates/update-history.service";
import { updateInstallService } from "./services/updates/update-install.service";
import { resourceAllocator } from "./system/resource-allocator.service";
import { cleanupStartupDirectories, ensureDataDirectories } from "./system/server-data.utils";
import { serverRescueService } from "./system/server-rescue.service";
import { Shutdown, type ShutdownStep, setActiveShutdown } from "./system/shutdown.service";
import { systemdWatchdogService } from "./system/systemd-watchdog.service";
import { flushLogs, logger, setLogLevel } from "./utils/logger.utils";
import { isUsableOriginEntry } from "./utils/origin-trust.utils";
import { detach, detachCatching, withTimeout } from "./utils/promise.utils";
import { loadBuiltInWorkers } from "./workers/built-in.loader";
import { workerService } from "./workers/worker.service";

/** Matches the leading major of FFmpeg versions like `7.0.2`, `6.1.1-3ubuntu5` or `n7.0`. */
const FFMPEG_MAJOR_VERSION_REGEX = /^n?(\d+)/;

/** Wildcard binds are reachable from any network the host is on. */
const PUBLIC_BIND_HOSTS: ReadonlySet<string> = new Set(["0.0.0.0", "::", "*"]);

// Per-step shutdown budgets. The global 30 s timer is the last resort: one slow
// step must not skip the FFmpeg kill, plugin unload or database close.
const SHUTDOWN_FAST_STEP_MS = 3_000;
const SHUTDOWN_HTTP_STEP_MS = 8_000;
const SHUTDOWN_WORKERS_STEP_MS = 12_000;
const SHUTDOWN_STREAMING_STEP_MS = 8_000;
const SHUTDOWN_PLUGINS_STEP_MS = 8_000;
const SHUTDOWN_LOG_FLUSH_MS = 5_000;

/**
 * Boot-failure paths run before the shutdown timer exists. A full disk or a
 * blocked stdout pipe must not keep a failed process alive forever.
 */
async function flushLogsBounded(): Promise<void> {
	try {
		await withTimeout(flushLogs(), SHUTDOWN_LOG_FLUSH_MS, "flush logs before exit");
	} catch {
		// The process is already exiting; losing the last lines is better than hanging.
	}
}

/** Registers the scan callbacks and starts watcher reconciliation without holding up `app.listen`. */
function registerLibraryWatchers(): void {
	logger.info("Initializing library watchers...");
	// A watched change rescans the path; the periodic fallback rescans the whole library.
	libraryWatcherService.registerScanner((libraryId, pathId) => librariesService.scanPath(libraryId, pathId));
	libraryWatcherService.registerLibraryScanner((libraryId) => librariesService.scan(libraryId));
	// Watcher startup stats every configured path. A dead mount used to delay
	// `app.listen` by 15 s per path; let the HTTP listener come up first and
	// finish reconciliation in the background.
	detachCatching(libraryWatcherService.init(), (error) => logger.warn("Library watcher initialization failed", { error }));
}

/** Seeds the media-stats summary once; after this boot every media-file write keeps it current. */
async function buildMediaStatsIfMissing(): Promise<void> {
	if (await hasCatalogMediaStats()) return;

	logger.info("Building media statistics summary...");
	await rebuildMediaStats();
}

async function setupServer(): Promise<void> {
	try {
		logger.info("Checking directories and files...");
		// awaits: sequential — the data directories exist before startup cleanup runs
		await ensureDataDirectories();
		await cleanupStartupDirectories();
		updateInstallService.cleanupStaleArtifacts();

		// Apply pending schema migrations before any repository touches the DB.
		logger.info("Applying database migrations...");
		const { applied } = databaseFactory.migrate();
		logger.info("Database migrations applied", { appliedMigrations: applied });

		// Fill the media-presence stamp for databases that predate the column, so
		// catalog lists and the recently-added rank never miss a title.
		// awaits: sequential — the backfill runs before the media stats are built
		await backfillLatestMediaCreatedAt();
		await buildMediaStatsIfMissing();

		// Better Auth's own user writes create the first profile; registered before any user can be created.
		registerAuthListeners();

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
		// A plugin channel that stops delivering tells the administrators once, with its error.
		onNotificationChannelFailure((failure) => detach(reportChannelFailureToAdministrators(failure)));
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
		resourceAllocator.registerActiveStreamsProvider(() => streamingManager.getActiveSessions());
		// Resource alerts and rescue state are admin-panel material — keep them off non-admin sockets.
		resourceAllocator.registerAlertListener(async (alert) => {
			adminFailureNotificationService.notifyResourceAlert(alert.code, alert.params ?? {});
			await realtimeService.sendToAdmins("system.resource_alert", alert);
		});
		await resourceAllocator.initialize();

		// Arm the server rescue monitor (event-loop lag + system pressure watchdog)
		serverRescueService.registerPressureProvider(() => resourceAllocator.getCurrentSnapshot()?.pressure ?? "low");
		serverRescueService.registerSpeedFactorProvider(() => systemResourcesService.getSpeedFactor());
		serverRescueService.registerStateListener(async (state) => await realtimeService.sendToAdmins("system.rescue_state", state));
		serverRescueService.init();

		registerLibraryWatchers();

		// Fire-and-forget: a slow or unreachable GitHub must never delay boot.
		scheduleStartupUpdateCheck();
	} catch (error) {
		logger.error("Failed to start server", error);
		await flushLogsBounded();
		process.exit(1);
	}
}
await setupServer();

const app = createHttpApp();

/**
 * The order matters: intake stops first, background work next, queues and
 * streams after that, and the database closes last, once nothing writes to it.
 */
const shutdownSteps: ShutdownStep[] = [
	// Tell systemd first: the watchdog window must stop before the slower steps,
	// otherwise a normal restart could look like a hung process and be killed.
	{
		name: "systemd-watchdog",
		message: "Notifying systemd...",
		run: () => systemdWatchdogService.stop(),
		timeoutMs: SHUTDOWN_FAST_STEP_MS,
	},
	// Realtime next: app.stop() waits for open sockets to drain, and a connected
	// events WebSocket never closes on its own — stopping the server before telling
	// clients to go away deadlocked shutdown until the timeout.
	{
		name: "realtime",
		message: "Closing realtime connections...",
		run: () => realtimeService.shutdown(),
		timeoutMs: SHUTDOWN_FAST_STEP_MS,
	},
	{
		name: "http",
		message: "Stopping server...",
		run: () => app.stop(),
		timeoutMs: SHUTDOWN_HTTP_STEP_MS,
		// A playlist request may legitimately outlive the budget; close the
		// remaining sockets abruptly instead of skipping every later step.
		onTimeout: () => app.stop(true),
	},
	{
		name: "library-watchers",
		message: "Stopping library watchers...",
		run: () => libraryWatcherService.shutdown(),
		timeoutMs: SHUTDOWN_FAST_STEP_MS,
	},
	{
		name: "resource-allocator",
		message: "Shutting down resource allocator...",
		run: () => resourceAllocator.shutdown(),
		timeoutMs: SHUTDOWN_FAST_STEP_MS,
	},
	{
		name: "server-rescue",
		message: "Stopping server rescue monitor...",
		run: () => serverRescueService.shutdown(),
		timeoutMs: SHUTDOWN_FAST_STEP_MS,
	},
	{
		name: "workers",
		message: "Shutting down queue system...",
		run: () => workerService.shutdown(),
		timeoutMs: SHUTDOWN_WORKERS_STEP_MS,
	},
	// Retention sweeps query the database, so they stop before it closes.
	{
		name: "download-sweeps",
		message: "Stopping download retention sweeps...",
		run: () => downloadsService.shutdown(),
		timeoutMs: SHUTDOWN_FAST_STEP_MS,
	},
	{
		name: "streaming",
		message: "Closing streaming sessions...",
		run: () => streamingManager.shutdown(),
		timeoutMs: SHUTDOWN_STREAMING_STEP_MS,
	},
	{
		name: "ffmpeg",
		message: "Terminating FFmpeg processes...",
		run: () => ffMpegService.killAll(),
		timeoutMs: SHUTDOWN_FAST_STEP_MS,
	},
	// Plugins get their onDisable/onUnload/dispose while the database is still open.
	{
		name: "plugins",
		message: "Unloading plugins...",
		run: () => pluginManager.shutdown(),
		timeoutMs: SHUTDOWN_PLUGINS_STEP_MS,
	},
	{
		name: "database",
		message: "Closing database...",
		run: () => databaseFactory.shutdown(),
		timeoutMs: SHUTDOWN_FAST_STEP_MS,
	},
];

// Setup graceful shutdown
const shutdownHandler = new Shutdown(shutdownSteps);
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
			logger.info("Server started successfully", {
				port: env.APP_PORT,
				host: serverConfig.network.host,
				environment: env.NODE_ENV,
				database: serverConfig.paths.sqlite,
			});
			// READY and the periodic heartbeat must come from this event loop. A
			// blocked loop stops both, and systemd restarts the unit.
			systemdWatchdogService.start();
		},
	);
} catch (error) {
	// A taken port is the most common first-run failure — say how to fix it instead of dumping a stack.
	if (isAddressInUse(error)) {
		logger.fatal(
			`Port ${env.APP_PORT} is already in use on ${serverConfig.network.host}. Stop the other process or set APP_PORT to a free port.`,
		);
		await flushLogsBounded();
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
