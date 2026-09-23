import { join } from "node:path";
import type { ProfilePreferenceDefaults } from "@reelvault/sdk/common";
import { clamp } from "@/utils/math.utils";
import type { BackoffConfig } from "@/workers/worker.types";
import { systemSettingsStore } from "./config/system-settings.store";
import { env } from "./env";
import { DAY, HOUR, MINUTE, serverConstants } from "./server.constants";
import { systemResourcesService } from "./system/system-resources.service";

const WORKER_BACKOFF_2S: BackoffConfig = { type: "exponential", delayMs: 2_000 } as const;

/**
 * Resolves an ffmpeg/ffprobe binary path. A path saved in the admin UI wins,
 * then the environment fallback (set by the launchers of the bundled archives),
 * then the settings default (the command name, resolved through PATH).
 */
function resolveToolPath(key: "ffmpeg.path" | "ffprobe.path", envPath: string | undefined): string {
	const { value, isCustom } = systemSettingsStore.getWithMeta(key);
	if (isCustom) return value;

	const fromEnv = envPath?.trim();
	if (fromEnv) return fromEnv;

	return value;
}

/**
 * Server Configuration.
 *
 * Clearly separates:
 * 1. DYNAMIC RUNTIME CONFIGURATION (Values configurable by administrator via Admin Panel / system_settings)
 * 2. STATIC ARCHITECTURAL CONSTANTS (Fixed system invariants, path resolvers, protocol limits)
 */
export const serverConfig = {
	/** Smart CPU & Resource Allocation Engine */
	resources: {
		get monitoringEnabled() {
			return systemSettingsStore.get("system.resources.monitoringEnabled");
		},
		get monitoringIntervalMs() {
			return systemSettingsStore.get("system.resources.monitoringIntervalMs");
		},

		get memoryThresholdPercent() {
			return systemSettingsStore.get("system.resources.memoryThresholdPercent");
		},
		get memoryCriticalPercent() {
			return systemSettingsStore.get("system.resources.memoryCriticalPercent");
		},

		get diskThresholdPercent() {
			return systemSettingsStore.get("system.resources.diskThresholdPercent");
		},

		get enableDynamicThrottling() {
			return systemSettingsStore.get("system.resources.enableDynamicThrottling");
		},
		get throttleLowPriorityAbovePercent() {
			return systemSettingsStore.get("system.resources.throttleLowPriorityAbovePercent");
		},

		get streamingGuaranteedCores() {
			return systemSettingsStore.get("system.resources.streamingGuaranteedCores");
		},
	},

	/** Server Rescue — emergency throttle of all background work when the server is drowning */
	rescue: {
		get enabled() {
			return systemSettingsStore.get("system.rescue.enabled");
		},
		get eventLoopLagMs() {
			return systemSettingsStore.get("system.rescue.eventLoopLagMs");
		},
		get sustainMs() {
			return systemSettingsStore.get("system.rescue.sustainMs");
		},
		get releaseMs() {
			return systemSettingsStore.get("system.rescue.releaseMs");
		},
	},

	/** Streaming & Transcoding Engine */
	stream: {
		...serverConstants.stream,
		// First-playlist wait on a slow transcode core — scale, cap 2×.
		get playlistTimeoutMs() {
			return systemResourcesService.scaledTimeoutMs(serverConstants.stream.playlistTimeoutMs);
		},
		get initialSegmentTimeoutMs() {
			return systemResourcesService.scaledTimeoutMs(serverConstants.stream.initialSegmentTimeoutMs);
		},
		get seekSegmentTimeoutMs() {
			return systemResourcesService.scaledTimeoutMs(serverConstants.stream.seekSegmentTimeoutMs);
		},
		get recoverySegmentTimeoutMs() {
			return systemResourcesService.scaledTimeoutMs(serverConstants.stream.recoverySegmentTimeoutMs);
		},
		get maxSessions() {
			return systemSettingsStore.get("stream.maxSessions");
		},
		get maxSessionsPerUser() {
			return systemSettingsStore.get("stream.maxSessionsPerUser");
		},
		get maxPerStreamBandwidthKbps() {
			return systemSettingsStore.get("stream.maxPerStreamBandwidthKbps");
		},
		get hlsSegmentDurationSeconds() {
			return systemSettingsStore.get("stream.hlsSegmentDurationSeconds");
		},
		get inactivityTimeoutMs() {
			return systemSettingsStore.get("stream.inactivityTimeoutMs");
		},
	},

	/** Media & Audio Engine */
	media: {
		...serverConstants.media,
	},

	/** Image Optimization & Dimensions */
	images: {
		...serverConstants.images,
		get maxWidth() {
			return systemSettingsStore.get("images.maxWidth");
		},
		get maxHeight() {
			return systemSettingsStore.get("images.maxHeight");
		},
		get maxUploadBytes() {
			return systemSettingsStore.get("images.maxUploadBytes");
		},
		optimization: {
			get defaultQuality() {
				return systemSettingsStore.get("images.defaultQuality");
			},
			get defaultWidth() {
				return systemSettingsStore.get("images.defaultWidth");
			},
		},
	},

	/** Library Scanner & FFprobe Concurrency */
	scanning: {
		get autoWatcherEnabled() {
			return systemSettingsStore.get("scanning.autoWatcherEnabled");
		},
		get autoWatcherDelaySeconds() {
			return systemSettingsStore.get("scanning.autoWatcherDelaySeconds");
		},
		get autoWatcherCooldownSeconds() {
			return systemSettingsStore.get("scanning.autoWatcherCooldownSeconds");
		},
		get concurrency() {
			return systemSettingsStore.get("scanning.concurrency");
		},
		get ffprobeConcurrency() {
			return systemSettingsStore.get("scanning.ffprobeConcurrency");
		},
	},

	/** Chapter-derived markers: configurable per-language keyword lists */
	markers: {
		get introKeywords() {
			return systemSettingsStore.get("markers.introKeywords");
		},
		get creditsKeywords() {
			return systemSettingsStore.get("markers.creditsKeywords");
		},
		get recapKeywords() {
			return systemSettingsStore.get("markers.recapKeywords");
		},
	},

	/** Built-in downloads (offline copies) */
	downloads: {
		get enabled() {
			return systemSettingsStore.get("downloads.enabled");
		},
		get maxStorageBytesPerProfile() {
			return systemSettingsStore.get("downloads.maxStorageBytesPerProfile");
		},
		get retentionDays() {
			return systemSettingsStore.get("downloads.retentionDays");
		},
	},

	/** Built-in trickplay (preview sprites) generation */
	trickplay: {
		get enabled() {
			return systemSettingsStore.get("trickplay.enabled");
		},
		get autoOnRefresh() {
			return systemSettingsStore.get("trickplay.autoOnRefresh");
		},
		get intervalSeconds() {
			return systemSettingsStore.get("trickplay.intervalSeconds");
		},
		get tileWidth() {
			return systemSettingsStore.get("trickplay.tileWidth");
		},
		get columns() {
			return systemSettingsStore.get("trickplay.columns");
		},
	},

	/** FFmpeg Transcoder & Hardware Acceleration */
	ffmpeg: {
		...serverConstants.ffmpeg,
		get path() {
			return resolveToolPath("ffmpeg.path", env.APP_FFMPEG_PATH);
		},
		get hwaccel() {
			return systemSettingsStore.get("ffmpeg.hwaccel");
		},
		get hwaccelDevice() {
			return systemSettingsStore.get("ffmpeg.hwaccelDevice");
		},
		get toneMapping() {
			return systemSettingsStore.get("ffmpeg.toneMapping");
		},
		get toneMapAlgorithm() {
			return systemSettingsStore.get("ffmpeg.toneMapAlgorithm");
		},
		get gracefulShutdownTimeoutMs() {
			return systemSettingsStore.get("ffmpeg.gracefulShutdownTimeoutMs");
		},
		get preset() {
			return systemSettingsStore.get("ffmpeg.preset");
		},
		get crf() {
			return systemSettingsStore.get("ffmpeg.crf");
		},
		get threads() {
			return systemSettingsStore.get("ffmpeg.threads");
		},
	},

	/** Worker Task Queues & Schedulers */
	workers: {
		scheduling: {
			...serverConstants.workers.scheduling,
			get pollIntervalMs() {
				return systemSettingsStore.get("workers.scheduling.pollIntervalMs");
			},
		},
		definitions: {
			...serverConstants.workers.fixedDefinitions,
			imageProcessing: {
				get concurrency() {
					return systemSettingsStore.get("workers.definitions.imageProcessing.concurrency");
				},
				timeoutMs: 5 * MINUTE,
				removeOnComplete: 100,
				removeOnFail: 100,
				priorities: { metadata: 1, season: 2, episode: 3, person: 4 },
			},
			mediaFileAnalysis: {
				get concurrency() {
					return systemSettingsStore.get("workers.definitions.mediaFileAnalysis.concurrency");
				},
				timeoutMs: 10 * MINUTE,
				attempts: 3,
				backoff: WORKER_BACKOFF_2S,
				removeOnComplete: 100,
				removeOnFail: 100,
			},
			mediaFileTechnicalRefresh: {
				get concurrency() {
					return systemSettingsStore.get("workers.definitions.mediaFileTechnicalRefresh.concurrency");
				},
				timeoutMs: 10 * MINUTE,
				attempts: 3,
				backoff: WORKER_BACKOFF_2S,
				removeOnComplete: 100,
				removeOnFail: 100,
			},
			metadataRefresh: {
				get concurrency() {
					return systemSettingsStore.get("workers.definitions.metadataRefresh.concurrency");
				},
				timeoutMs: HOUR,
				removeOnComplete: 10,
				removeOnFail: 50,
			},
			// Overrides the spread above: each stream-init task spawns an FFmpeg
			// process, so concurrency derives from measured CPU capacity — a weak
			// 12-thread box gets 1-2 parallel stream starts, a fast one gets 2.
			streamInitialization: {
				get concurrency() {
					return systemResourcesService.getHeavySubprocessConcurrency();
				},
				timeoutMs: 2 * MINUTE,
				attempts: 1,
				removeOnComplete: 100,
				removeOnFail: 100,
			},
			// One file at a time — the generator itself fans out per-sprite ffmpeg
			// processes sized from measured CPU capacity.
			trickplayGenerate: {
				concurrency: 1,
				timeoutMs: 30 * MINUTE,
				attempts: 1,
				removeOnComplete: 100,
				removeOnFail: 100,
			},
			downloadsProcess: {
				concurrency: 1,
				timeoutMs: 2 * HOUR,
				attempts: 1,
				removeOnComplete: 100,
				removeOnFail: 100,
			},
			// Overrides the spread: ingest runs an ffprobe plus catalog writes per
			// file — derive from measured CPU capacity, not a fixed number.
			mediaFileIngest: {
				get concurrency() {
					return systemResourcesService.getIngestConcurrency();
				},
				timeoutMs: 30 * MINUTE,
				attempts: 3,
				backoff: WORKER_BACKOFF_2S,
				removeOnComplete: 100,
				removeOnFail: 100,
			},
		},
	},

	/** Collections Configuration */
	collections: {
		get minimalToShow() {
			return systemSettingsStore.get("collections.minimalToShow");
		},
	},

	/** Metadata Aggregation */
	metadata: {
		get ratingAggregation() {
			return systemSettingsStore.get("metadata.ratingAggregation");
		},
	},

	/** Plugin Details Cache */
	plugins: {
		...serverConstants.plugins,
		get blobs() {
			return {
				...serverConstants.plugins.blobs,
				cleanupConcurrency: systemResourcesService.getIoConcurrency(),
			};
		},
		get artifacts() {
			return {
				...serverConstants.plugins.artifacts,
				cleanupConcurrency: systemResourcesService.getIoConcurrency(),
			};
		},
		get lifecycle() {
			return {
				...serverConstants.plugins.lifecycle,
				// Importing plugin modules is JS-eval CPU work at boot.
				loadConcurrency: clamp(Math.ceil(systemResourcesService.getMetrics().capacity / 2), 1, 4),
				disposeConcurrency: systemResourcesService.getIoConcurrency(),
				// JS eval on an RPi is several× slower — don't fail good plugins.
				loadTimeoutMs: systemResourcesService.scaledTimeoutMs(serverConstants.plugins.lifecycle.loadTimeoutMs),
			};
		},
		providers: {
			...serverConstants.plugins.providers,
			get detailsCacheTtlMs() {
				return systemSettingsStore.get("plugins.providers.detailsCacheTtlMs");
			},
			// ProviderDetails rows run 10-50 KB — scale with installed RAM.
			get detailsCacheMaxSize() {
				return systemResourcesService.getRamScaledCacheEntries(60, 200, 2000);
			},
		},
	},

	/** Database Runtime Retention */
	database: {
		...serverConstants.database,
		// Heavy chunked relation queries — scale fan-out with measured capacity.
		get relationQueryConcurrency() {
			return clamp(Math.ceil(systemResourcesService.getMetrics().capacity / 2), 1, 8);
		},
		get operationRetentionMs() {
			const days = systemSettingsStore.get("system.database.operationRetentionDays") || 7;

			return days * DAY;
		},
	},

	/** API Pagination */
	api: {
		...serverConstants.api,
		pagination: {
			...serverConstants.api.pagination,
			get defaultLimit() {
				return systemSettingsStore.get("api.pagination.defaultLimit");
			},
		},
	},

	/** User Profiles Default Preferences */
	profiles: {
		get maxProfilesPerUser(): number {
			return systemSettingsStore.get("profiles.maxProfilesPerUser");
		},
		getDefaultPreferences(): ProfilePreferenceDefaults {
			return {
				language: systemSettingsStore.get("profiles.defaultPreferences.language"),
				theme: systemSettingsStore.get("profiles.defaultPreferences.theme"),
				autoplay: systemSettingsStore.get("profiles.defaultPreferences.autoplay"),
				autoSkipIntro: systemSettingsStore.get("profiles.defaultPreferences.autoSkipIntro"),
				autoSkipCredits: systemSettingsStore.get("profiles.defaultPreferences.autoSkipCredits"),
				autoSkipRecap: systemSettingsStore.get("profiles.defaultPreferences.autoSkipRecap"),
				audioLanguage: systemSettingsStore.get("profiles.defaultPreferences.audioLanguage") || null,
				subtitleLanguage: systemSettingsStore.get("profiles.defaultPreferences.subtitleLanguage") || null,
				subtitlesEnabled: systemSettingsStore.get("profiles.defaultPreferences.subtitlesEnabled"),
				forcedSubtitlesOnly: systemSettingsStore.get("profiles.defaultPreferences.forcedSubtitlesOnly"),
				autoForcedSubtitles: systemSettingsStore.get("profiles.defaultPreferences.autoForcedSubtitles"),
				preferHearingImpaired: systemSettingsStore.get("profiles.defaultPreferences.preferHearingImpaired"),
				continueWatchingMinutes: systemSettingsStore.get("profiles.defaultPreferences.continueWatchingMinutes"),
				subtitleSize: systemSettingsStore.get("profiles.defaultPreferences.subtitleSize"),
				subtitlePosition: systemSettingsStore.get("profiles.defaultPreferences.subtitlePosition"),
				subtitleColor: systemSettingsStore.get("profiles.defaultPreferences.subtitleColor"),
				subtitleBackground: systemSettingsStore.get("profiles.defaultPreferences.subtitleBackground"),
			};
		},
		get defaultPreferences(): ProfilePreferenceDefaults {
			return serverConfig.profiles.getDefaultPreferences();
		},
	},

	/** Filesystem Paths Configuration (Dynamic runtime overrides) */
	paths: {
		...serverConstants.paths,
		get transcodes() {
			return systemSettingsStore.get("paths.transcodes");
		},
		get downloads() {
			return systemSettingsStore.get("paths.downloads");
		},
		get backups() {
			return systemSettingsStore.get("paths.backups");
		},
		get logsRetentionDays() {
			return systemSettingsStore.get("system.logs.retentionDays") || 7;
		},
		get imageTmp(): string {
			return join(serverConfig.paths.images, ".tmp");
		},
		get transcodeTmp(): string {
			return join(serverConfig.paths.transcodes, ".tmp");
		},
	},

	/** Network & Allowed Origins */
	network: {
		...serverConstants.network,
		get allowedOrigins(): string[] {
			return systemSettingsStore.get("network.allowedOrigins");
		},
		get trustLocalNetworks(): boolean {
			return systemSettingsStore.get("network.trustLocalNetworks");
		},
	},
	shutdown: serverConstants.shutdown,
	security: serverConstants.security,
	compression: serverConstants.compression,
	requestDedup: {
		...serverConstants.requestDedup,
		// In-flight responses are held serialized in RAM — the cap scales with
		// installed memory so a 4 GB box can't OOM on a catalog stampede.
		get maxConcurrent() {
			return systemResourcesService.getMaxInflightResponses();
		},
		// Followers wait for a leader whose latency is CPU-bound.
		get waitTimeoutMs() {
			return systemResourcesService.scaledTimeoutMs(serverConstants.requestDedup.waitTimeoutMs);
		},
	},
	ffprobe: {
		...serverConstants.ffprobe,
		// Probing huge remuxes over slow storage on weak CPUs can exceed a fixed
		// minute — scale with measured core speed.
		get timeoutMs() {
			return systemResourcesService.scaledTimeoutMs(serverConstants.ffprobe.timeoutMs);
		},
		get path() {
			return resolveToolPath("ffprobe.path", env.APP_FFPROBE_PATH);
		},
	},
	sharp: {
		...serverConstants.sharp,
		// A 40 MP RGBA decode pipeline holds ~160 MB × sharpConcurrency —
		// scale the decode ceiling with installed RAM (12 MP floor on tiny boxes).
		get maxInputPixels() {
			return clamp(Math.floor(((systemResourcesService.getTotalMemoryKiB() ?? 8_388_608) / 1024) * 6.4), 12_000_000, 40_000_000);
		},
	},
	application: {
		...serverConstants.application,
		// Delete/stat sweeps are pure fs I/O — scale with measured capacity so
		// slow storage never queues 8+ parallel unlinks.
		get cleanupConcurrency() {
			return systemResourcesService.getIoConcurrency();
		},
	},
	auth: serverConstants.auth,
	constants: serverConstants,
};
