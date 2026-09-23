import { join } from "node:path";
import { env } from "./env";

const KIBIBYTE = 1024;
const MEBIBYTE = KIBIBYTE * KIBIBYTE;

export const MINUTE = 60_000;

export const HOUR = 60 * MINUTE;

export const DAY = 24 * HOUR;

export const FFMPEG_TIMEOUT_MS = 10 * MINUTE;

export const daysAgo = (days: number) => new Date(Date.now() - days * DAY);

/**
 * Static Architectural Constants and Invariants.
 * These are fixed system limits, protocol constraints, filesystem anchors,
 * and security baselines that do not change at runtime.
 */
export const serverConstants = {
	network: {
		host: env.APP_HOST ?? (env.NODE_ENV === "production" ? "127.0.0.1" : "0.0.0.0"),
		trustedProxyCount: env.APP_TRUSTED_PROXY_COUNT,
	},
	media: {
		supportedVideoExtensions: [
			".mp4",
			".mkv",
			".avi",
			".mov",
			".m4v",
			".webm",
			".wmv",
			".flv",
			".m2ts",
			".mts",
			".vob",
			".ogv",
			".3gp",
			".3g2",
			".f4v",
			".mpeg",
			".mpg",
			".mpe",
			".asf",
			".rm",
			".rmvb",
			".divx",
		],
	},
	paths: {
		artifacts: join(env.ROOT_DIR, "artifacts"),
		images: join(env.ROOT_DIR, "images"),
		libraries: join(env.ROOT_DIR, "libraries"),
		pluginBlobs: join(env.ROOT_DIR, "plugin-blobs"),
		plugins: join(env.ROOT_DIR, "plugins"),
		subtitles: join(env.ROOT_DIR, "subtitles"),
		tasks: join(env.ROOT_DIR, "tasks"),
		transcodes: join(env.ROOT_DIR, "transcodes"),
		downloads: join(env.ROOT_DIR, "downloads"),
		logs: join(env.ROOT_DIR, "logs"),
		logFile: join(env.ROOT_DIR, "logs", "reelvault.log"),
		debugLogFile: join(env.ROOT_DIR, "logs", "debug.log"),
		backups: join(env.ROOT_DIR, "backups"),
		sqlite: join(env.ROOT_DIR, env.DB_FILE_NAME),
	},
	shutdown: {
		timeoutMs: 30_000,
	},
	security: {
		hstsMaxAgeSeconds: 31_536_000,
		contentTypeOptions: "nosniff",
		frameOptions: "DENY",
		referrerPolicy: "no-referrer",
		openApiContentSecurityPolicy:
			"default-src 'none'; base-uri 'none'; frame-ancestors 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline' https://cdn.jsdelivr.net; connect-src 'self'; img-src 'self' data: https:",
		defaultContentSecurityPolicy: "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
		/**
		 * SPA served by the server itself (APP_WEB_DIST). Self-hosted assets only;
		 * blob: covers MSE media and hls.js workers, data: inline images, and
		 * 'unsafe-inline' styles cover runtime style attributes. api.dicebear.com
		 * serves the profile avatar previews — the picked avatar is localized to
		 * /v1/images at save time, but the picker grid renders the remote URLs.
		 */
		webUiContentSecurityPolicy:
			"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://api.dicebear.com; media-src 'self' blob:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'",
		/**
		 * Plugin UI assets (ESM modules defining custom elements) are imported
		 * cross-origin by the host website. A permissive policy keeps any plugin-owned
		 * document/CSS working; the trust boundary is admin installation (plugin
		 * backend already runs in-process).
		 */
		pluginUiRoutePrefix: "/v1/plugins/ui/",
		pluginUiContentSecurityPolicy:
			"default-src 'self' data: blob: https: http:; script-src 'self' 'unsafe-inline' https: http:; style-src 'self' 'unsafe-inline' https: http:; img-src 'self' data: blob: https: http:; media-src 'self' data: blob: https: http:; font-src 'self' data: https: http:; connect-src 'self' https: http:; frame-src 'self' https: http:; frame-ancestors *; base-uri 'none'; form-action 'self' https: http:",
		permissionsPolicy: "camera=(), microphone=(), geolocation=()",
		imageRoutePrefix: "/v1/images/",
		cacheControl: "no-store",
		responseCache: {
			defaultMaxAge: 60,
			catalogMaxAge: 120,
			detailsMaxAge: 300,
		},
	},
	compression: {
		enabled: true,
		/**
		 * node:zlib defaults target one-shot archival payloads, not per-request
		 * API responses: brotli quality 11 costs hundreds of ms of a single core
		 * per 100-500 KB JSON on server-class CPUs. Quality 4 keeps ~95% of the
		 * ratio at a fraction of the cost on any hardware; level-1 gzip is the
		 * same trade for clients without brotli.
		 */
		brotliQuality: 4,
		brotliLgwin: 18,
		gzipLevel: 1,
		minSizeBytes: 1024,
		types: ["text/*", "application/json", "application/javascript", "application/xml", "application/x-mpegURL"],
		excludeTypes: ["image/*", "video/*", "audio/*", "application/octet-stream"],
	},
	requestDedup: {
		enabled: true,
		maxConcurrent: 256,
		/** Cap on how long a deduplicated follower waits for the leader's response. */
		waitTimeoutMs: 30_000,
		/**
		 * In-flight keys are kept verbatim (raw string beats hashing in the A/B
		 * micro suite for realistic key lengths). Pathological requests (giant
		 * cookies/URLs) fall back to a hash so the bounded in-flight map cannot be
		 * amplified into a memory sink. Hardware-independent guard, hence static.
		 */
		rawKeyMaxLength: 2048,
	},
	database: {
		busyTimeoutMs: 5_000,
		filters: { maxValues: 500 },
		fields: { maxLength: 2048, maxFields: 64, maxDepth: 4 },
		queryChunkSize: 500,
		relationQueryConcurrency: 4,
	},
	stream: {
		playlistTimeoutMs: 30_000,
		initialSegmentTimeoutMs: 8_000,
		seekSegmentTimeoutMs: 10_000,
		recoverySegmentTimeoutMs: 15_000,
		seekDebounceMs: 300,
		cleanupIntervalMs: 10_000,
		hlsMaxMuxingQueueSize: 2048,
		framesPerHlsSegment: 24,
		completedRequestTtlMs: MINUTE,
	},
	ffmpeg: {
		requiredAudioFilters: ["aresample"] as const,
	},
	ffprobe: {
		timeoutMs: MINUTE,
		maxOutputBytes: 8 * MEBIBYTE,
	},
	sharp: {
		maxInputPixels: 40_000_000,
	},
	images: {
		currentOptimizationVersion: 2,
		variants: {
			// effort is resolved at encode time from measured CPU capacity
			// (systemResourcesService.getImageEffort) — no static value here.
			poster: {
				width: 1000,
				height: 1500,
				fit: "cover",
				position: "attention",
				quality: 75,
				withoutEnlargement: true,
			},
			backdrop: {
				width: 1920,
				height: 1080,
				fit: "cover",
				position: "attention",
				quality: 75,
				withoutEnlargement: true,
			},
			avatar: {
				width: 512,
				height: 512,
				fit: "cover",
				position: "attention",
				quality: 85,
				withoutEnlargement: true,
			},
		} as const,
	},
	application: {
		cleanupConcurrency: 8,
		metadataImageProviderConcurrency: 4,
		metadataImageEnqueueConcurrency: 8,
		metadataPersonImageLimit: 25,
		discoverCandidateLimit: 500,
	},
	plugins: {
		storage: {
			maxKeyLength: 128,
			maxValueBytes: 64 * KIBIBYTE,
		},
		blobs: {
			maxBlobBytes: 20 * MEBIBYTE,
			maxStorageBytes: 100 * MEBIBYTE,
			retentionMs: 30 * DAY,
			maxContentTypeLength: 255,
			cleanupConcurrency: 8,
		},
		artifacts: {
			maxSizeBytes: 100 * MEBIBYTE,
			// Ceiling for the sum of one plugin's stored artifacts — a runaway
			// generator must not be able to fill the artifacts volume alone.
			maxTotalBytesPerPlugin: 512 * MEBIBYTE,
			// Content types a plugin artifact may carry; artifacts are served to
			// clients with this Content-Type, so scripts/markup stay out.
			allowedContentTypes: ["text/vtt", "text/plain", "application/json", "image/webp", "image/png", "image/jpeg"],
			cleanupConcurrency: 8,
		},
		ffmpeg: {
			maxOutputBytes: 10 * MEBIBYTE,
			minFrameDimension: 64,
			maxFrameDimension: 3840,
			maxSpriteFrames: 100,
			maxSpriteWidth: 1920,
			maxSpriteHeight: 1080,
			maxSpritePixels: 16_000_000,
		},
		providers: {
			detailsCacheMaxSize: 1_000,
			concurrency: 8,
			defaultPriority: 100,
			settingsCacheTtlMs: 30_000,
		},
		subtitles: {
			maxSizeBytes: 20 * MEBIBYTE,
			supportedFormats: ["ass", "srt", "ssa", "sub", "vtt"] as const,
			providerConcurrency: 8,
		},
		runtime: {
			accessPolicyTimeoutMs: 1_000,
			hookTimeoutMs: 5_000,
		},
		// Per-plugin flood guard for the notifications capability — a buggy plugin
		// must not bury the user's notification feed (0 would disable creation).
		notifications: {
			maxPerDayPerPlugin: 100,
		},
		lifecycle: {
			loadTimeoutMs: MINUTE,
			loadConcurrency: 4,
			disposeConcurrency: 8,
			// Per-plugin cap on onDisable/onUnload during process shutdown — well
			// under shutdown.timeoutMs so one hung plugin cannot force-kill the exit.
			unloadTimeoutMs: 5_000,
		},
	},
	workers: {
		scheduling: {
			defaultConcurrency: 1,
			defaultTimeoutMs: 5 * MINUTE,
			defaultAttempts: 3,
			defaultBackoff: { type: "exponential", delayMs: 1_000 } as const,
			defaultRemoveOnComplete: 100,
			defaultRemoveOnFail: 100,
		},
		fixedDefinitions: {
			libraryErrorsCheck: { concurrency: 1, timeoutMs: 6 * HOUR, attempts: 1, removeOnComplete: 100, removeOnFail: 100 },
			libraryScan: { concurrency: 1, timeoutMs: 2 * HOUR, removeOnComplete: 100, removeOnFail: 100 },
			mediaFilesRefreshAll: { concurrency: 1, timeoutMs: 30 * MINUTE, attempts: 1, removeOnComplete: 100, removeOnFail: 100 },
			mediaMatchAudit: { concurrency: 4, timeoutMs: MINUTE, attempts: 1, removeOnComplete: 100, removeOnFail: 100 },
			mediaMatchAuditScan: { concurrency: 1, timeoutMs: 30 * MINUTE, attempts: 1, removeOnComplete: 50, removeOnFail: 50 },
			// Full-catalog CPU scan — one at a time, generous stall timeout.
			mediaFileAuditReport: { concurrency: 1, timeoutMs: HOUR, attempts: 1, removeOnComplete: 50, removeOnFail: 50 },
		},
	},
	api: {
		pagination: {
			maxLimit: 500,
			maxPage: 100_000,
		},
		rateLimit: {
			maxBuckets: 10_000,
			cleanupWindowMs: MINUTE,
			// Deployment/benchmark tuning: reverse proxies in front of the server may
			// aggregate many clients behind one source IP, and load tests must not
			// measure the rate limiter instead of the server. Env hatches live in
			// env.ts (documented in .env.example); unset env keeps these defaults.
			globalMax: env.REELVAULT_RATE_LIMIT_GLOBAL_MAX ?? 1000,
			globalWindowMs: MINUTE,
			routeMultiplier: env.REELVAULT_RATE_LIMIT_ROUTE_MULTIPLIER ?? 1,
			tiers: {
				anonymous: { max: 1000, windowMs: MINUTE },
				authenticated: { max: 5000, windowMs: MINUTE },
				admin: { max: 10_000, windowMs: MINUTE },
			},
		},
		requestTimeout: {
			defaultMs: 30_000,
			batchMs: 5 * MINUTE,
			maxMs: 10 * MINUTE,
		},
		openapi: {
			enabled: env.OPENAPI_DOCS_ENABLED === "true",
			path: "/openapi",
			title: "ReelVault API",
			description: "REST API for the ReelVault media streaming server.",
			version: "1.0.0",
		},
	},
	auth: {
		appName: "ReelVault",
		// Secure by default: explicit APP_SECURE wins, otherwise derive from the
		// public URL scheme (https → secure) and fall back to secure in production.
		// Only a dev over plain HTTP (or an explicit APP_SECURE=false) opts out.
		secureCookies:
			env.APP_SECURE === "true" ||
			(env.APP_SECURE === undefined && (env.APP_PUBLIC_URL?.startsWith("https://") ?? env.NODE_ENV === "production")),
		emailAndPasswordEnabled: true,
		/**
		 * Auth middleware resolves the active profile on every authenticated
		 * request; a short shared TTL avoids one DB round-trip per request.
		 * Bounded below by correctness: profile changes (rename, ownership)
		 * become visible to auth context after at most this long.
		 */
		profileCacheTtlMs: 10_000,
		profileCacheMaxEntries: 1_000,
		rateLimit: {
			// Load-test escape hatch: better-auth's limiter keys on the socket IP,
			// which a load test cannot spread across identities. Defaults to enabled.
			enabled: env.REELVAULT_AUTH_RATE_LIMIT_ENABLED !== "false",
			windowSeconds: 60,
			max: 100,
			emailSignIn: { windowSeconds: 60, max: 5 },
			emailSignUp: { windowSeconds: 15 * 60, max: 5 },
			/** Per-account throttle (attempts per {@link loginAccountWindowMs}) —
			 * protects one mailbox from distributed brute-force. Raised only by
			 * soak tests through REELVAULT_LOGIN_ACCOUNT_MAX_ATTEMPTS. */
			loginAccountMaxAttempts: env.REELVAULT_LOGIN_ACCOUNT_MAX_ATTEMPTS,
		},
	},
};

/** matchScore below this value is treated as a low-confidence provider match. */
export const LOW_CONFIDENCE_MATCH_SCORE = 0.75;
