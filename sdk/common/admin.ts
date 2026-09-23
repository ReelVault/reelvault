import { t } from "elysia";

export const AdminUserSchema = t.Object({
	id: t.String(),
	name: t.String(),
	email: t.String({ format: "email" }),
	role: t.Union([t.Literal("admin"), t.Literal("user")]),
	banned: t.Boolean(),
	banReason: t.Nullable(t.String()),
	banExpires: t.Nullable(t.String({ format: "date-time" })),
	twoFactorEnabled: t.Boolean(),
	createdAt: t.String({ format: "date-time" }),
	updatedAt: t.String({ format: "date-time" }),
});

export type AdminUser = typeof AdminUserSchema.static;

export const AdminUserProfileSchema = t.Object({
	id: t.String(),
	userId: t.String(),
	name: t.String(),
	avatarUrl: t.Nullable(t.String()),
	hasPin: t.Boolean(),
	createdAt: t.String({ format: "date-time" }),
	updatedAt: t.String({ format: "date-time" }),
});

export type AdminUserProfile = typeof AdminUserProfileSchema.static;

export const AdminUsersPageSchema = t.Object({
	data: t.Array(AdminUserSchema),
	pagination: t.Object({
		total: t.Integer({ minimum: 0 }),
		page: t.Integer({ minimum: 1 }),
		limit: t.Integer({ minimum: 1 }),
		totalPages: t.Integer({ minimum: 0 }),
	}),
});

export type AdminUsersPage = typeof AdminUsersPageSchema.static;

export const AdminCreateUserSchema = t.Object({
	name: t.String({ minLength: 1, maxLength: 100 }),
	email: t.String({ format: "email" }),
	password: t.String({ minLength: 8, maxLength: 128 }),
	role: t.Optional(t.Union([t.Literal("admin"), t.Literal("user")])),
});

export type AdminCreateUser = typeof AdminCreateUserSchema.static;

export const AdminCreateUserProfileSchema = t.Object({
	name: t.String({ minLength: 1, maxLength: 100 }),
	avatarUrl: t.Optional(t.Nullable(t.String({ maxLength: 2048 }))),
	pin: t.Optional(t.Nullable(t.String({ minLength: 4, maxLength: 32 }))),
});

export type AdminCreateUserProfile = typeof AdminCreateUserProfileSchema.static;

export const AdminSetUserPasswordSchema = t.Object({
	newPassword: t.String({ minLength: 8, maxLength: 128 }),
});

export type AdminSetUserPassword = typeof AdminSetUserPasswordSchema.static;

export const AdminStatsSchema = t.Object({
	uptime: t.Number({ minimum: 0 }),
	memory: t.Object({
		rss: t.Number({ minimum: 0 }),
		heapTotal: t.Number({ minimum: 0 }),
		heapUsed: t.Number({ minimum: 0 }),
		heapLimit: t.Optional(t.Number({ minimum: 0 })),
		external: t.Number({ minimum: 0 }),
		arrayBuffers: t.Number({ minimum: 0 }),
	}),
	systemMemory: t.Optional(
		t.Object({
			usedMb: t.Number({ minimum: 0 }),
			totalMb: t.Number({ minimum: 0 }),
			percent: t.Number({ minimum: 0, maximum: 100 }),
		}),
	),
	pressure: t.Optional(t.Union([t.Literal("low"), t.Literal("medium"), t.Literal("high"), t.Literal("critical")])),
	streaming: t.Object({
		activeSessions: t.Integer({ minimum: 0 }),
	}),
	timestamp: t.String({ format: "date-time" }),
	workers: t.Optional(
		t.Object({
			active: t.Integer({ minimum: 0 }),
			waiting: t.Integer({ minimum: 0 }),
			completed: t.Integer({ minimum: 0 }),
			failed: t.Integer({ minimum: 0 }),
		}),
	),
	media: t.Optional(
		t.Object({
			totalFiles: t.Integer({ minimum: 0 }),
			totalSize: t.Integer({ minimum: 0 }),
			moviesCount: t.Integer({ minimum: 0 }),
			episodesCount: t.Integer({ minimum: 0 }),
			withQualityCount: t.Integer({ minimum: 0 }),
		}),
	),
	metadata: t.Optional(
		t.Object({
			totalCount: t.Integer({ minimum: 0 }),
			moviesCount: t.Integer({ minimum: 0 }),
			tvShowsCount: t.Integer({ minimum: 0 }),
			lowConfidenceCount: t.Integer({ minimum: 0 }),
			missingTranslationCount: t.Integer({ minimum: 0 }),
		}),
	),
	markers: t.Optional(
		t.Object({
			totalCount: t.Integer({ minimum: 0 }),
			introsCount: t.Integer({ minimum: 0 }),
			creditsCount: t.Integer({ minimum: 0 }),
			highlightsCount: t.Integer({ minimum: 0 }),
			fromPluginsCount: t.Integer({ minimum: 0 }),
		}),
	),
});

export type AdminStats = typeof AdminStatsSchema.static;

export const AdminCacheDirStatsSchema = t.Object({
	bytes: t.Integer({ minimum: 0 }),
	files: t.Integer({ minimum: 0 }),
});

export const AdminCacheStatsSchema = t.Object({
	timestamp: t.String({ format: "date-time" }),
	disk: t.Object({
		transcodes: AdminCacheDirStatsSchema,
		images: AdminCacheDirStatsSchema,
		subtitles: AdminCacheDirStatsSchema,
	}),
	memory: t.Array(
		t.Object({
			name: t.String({ maxLength: 100 }),
			entries: t.Integer({ minimum: 0 }),
			maxSize: t.Nullable(t.Integer({ minimum: 1 })),
			hits: t.Integer({ minimum: 0 }),
			misses: t.Integer({ minimum: 0 }),
			hitRate: t.Nullable(t.Number({ minimum: 0, maximum: 1 })),
		}),
	),
});

export type AdminCacheStats = typeof AdminCacheStatsSchema.static;

export const AdminResourceAlertSchema = t.Object({
	type: t.String(),
	code: t.String(),
	params: t.Optional(t.Union([t.Record(t.String(), t.Union([t.String(), t.Number(), t.Boolean(), t.Null()])), t.Undefined()])),
	severity: t.Union([t.Literal("warning"), t.Literal("critical")]),
	metric: t.Optional(t.Number()),
	threshold: t.Optional(t.Number()),
	workerId: t.Optional(t.String()),
	timestamp: t.Union([t.String(), t.Number()]),
});

export const AdminResourceAggregatesSchema = t.Object({
	avgCpu: t.Number({ minimum: 0 }),
	maxCpu: t.Number({ minimum: 0 }),
	avgMemory: t.Number({ minimum: 0 }),
	maxMemory: t.Number({ minimum: 0 }),
	avgDisk: t.Number({ minimum: 0 }),
	maxDisk: t.Number({ minimum: 0 }),
});

export const AdminSystemCpuSchema = t.Object({
	detectedCores: t.Number(),
	configuredMaxCores: t.Number(),
	effectiveCores: t.Number(),
	speedFactor: t.Number(),
	capacity: t.Number(),
	cpuProfile: t.Union([t.Literal("conservative"), t.Literal("balanced"), t.Literal("performance"), t.Literal("custom")]),
	reservedWebCores: t.Number(),
	backgroundBudgetCores: t.Number(),
	ffmpegThreads: t.Number(),
	sharpConcurrency: t.Number(),
	workerPoolMaxConcurrent: t.Number(),
	scannerConcurrency: t.Number(),
	ffprobeConcurrency: t.Number(),
});

export type AdminSystemCpu = typeof AdminSystemCpuSchema.static;

export const AdminRescueStateSchema = t.Object({
	state: t.Union([t.Literal("healthy"), t.Literal("rescuing")]),
	stateSince: t.Number(),
	reason: t.Optional(t.Union([t.String(), t.Undefined()])),
	lastLagMs: t.Number(),
	lastPressure: t.Union([t.Literal("low"), t.Literal("medium"), t.Literal("high"), t.Literal("critical")]),
	escalations: t.Number(),
});

export type AdminRescueState = typeof AdminRescueStateSchema.static;

export const AdminWorkerAllocationSchema = t.Object({
	workerId: t.String(),
	requested: t.Number(),
	allocated: t.Number(),
	throttled: t.Boolean(),
	reason: t.Optional(t.Union([t.String(), t.Undefined()])),
});

export type AdminWorkerAllocation = typeof AdminWorkerAllocationSchema.static;

export const AdminResourcesResponseSchema = t.Object({
	current: t.Optional(
		t.Nullable(
			t.Object({
				timestamp: t.Number(),
				cpu: t.Object({
					usedPercent: t.Number({ minimum: 0, maximum: 100 }),
					loadAvg: t.Tuple([t.Number(), t.Number(), t.Number()]),
				}),
				memory: t.Object({
					usedMb: t.Number({ minimum: 0 }),
					totalMb: t.Number({ minimum: 0 }),
					percent: t.Number({ minimum: 0, maximum: 100 }),
				}),
				disk: t.Object({
					usedGb: t.Number({ minimum: 0 }),
					totalGb: t.Number({ minimum: 0 }),
					percent: t.Number({ minimum: 0, maximum: 100 }),
				}),
				pressure: t.Union([t.Literal("low"), t.Literal("medium"), t.Literal("high"), t.Literal("critical")]),
				activeStreams: t.Number({ minimum: 0 }),
				workers: t.Record(t.String(), t.Number()),
			}),
		),
	),
	history: t.Array(
		t.Object({
			id: t.Union([t.String(), t.Integer()]),
			timestamp: t.String(),
			cpu: t.Number(),
			memory: t.Number(),
			disk: t.Number(),
			pressure: t.String(),
			workersJson: t.Optional(t.String()),
		}),
	),
	alerts: t.Array(AdminResourceAlertSchema),
	aggregates: AdminResourceAggregatesSchema,
	config: t.Object({
		monitoringEnabled: t.Boolean(),
		memoryThresholdPercent: t.Number({ minimum: 0, maximum: 100 }),
		diskThresholdPercent: t.Number({ minimum: 0, maximum: 100 }),
		enableDynamicThrottling: t.Boolean(),
	}),
	systemCpu: t.Optional(AdminSystemCpuSchema),
	rescue: t.Optional(AdminRescueStateSchema),
	workerAllocations: t.Optional(t.Array(AdminWorkerAllocationSchema)),
});

export type AdminResourcesResponse = typeof AdminResourcesResponseSchema.static;

export const AdminLogEntrySchema = t.Object(
	{
		levelName: t.String(),
		timestamp: t.String({ format: "date-time" }),
		module: t.Optional(t.String()),
		msg: t.Optional(t.String()),
		err: t.Optional(t.Unknown()),
		errorDetails: t.Optional(t.Unknown()),
	},
	{ additionalProperties: true },
);

export type AdminLogEntry = typeof AdminLogEntrySchema.static;

export const AdminLogsPageSchema = t.Object({
	data: t.Array(AdminLogEntrySchema),
	pagination: t.Object({
		total: t.Integer({ minimum: 0 }),
		page: t.Integer({ minimum: 1 }),
		limit: t.Integer({ minimum: 1 }),
		totalPages: t.Integer({ minimum: 0 }),
	}),
});

export type AdminLogsPage = typeof AdminLogsPageSchema.static;

export const AdminLogFileInfoSchema = t.Object({
	id: t.String(),
	name: t.String(),
	type: t.Union([
		t.Literal("server"),
		t.Literal("ffmpeg-transcode"),
		t.Literal("ffmpeg-directstream"),
		t.Literal("ffmpeg"),
		t.Literal("other"),
	]),
	size: t.Integer({ minimum: 0 }),
	modifiedAt: t.String({ format: "date-time" }),
});

export type AdminLogFileInfo = typeof AdminLogFileInfoSchema.static;

export const AdminAuditActionSchema = t.Union([t.Literal("create"), t.Literal("update"), t.Literal("delete")]);

export const AdminAuditEntrySchema = t.Object({
	id: t.String(),
	actorUserId: t.Nullable(t.String()),
	action: AdminAuditActionSchema,
	resourceType: t.String(),
	resourceId: t.Nullable(t.String()),
	resourceName: t.Nullable(t.String()),
	summary: t.Nullable(t.String()),
	before: t.Nullable(t.Unknown()),
	after: t.Nullable(t.Unknown()),
	requestId: t.Nullable(t.String()),
	ipAddress: t.Nullable(t.String()),
	userAgent: t.Nullable(t.String()),
	createdAt: t.String({ format: "date-time" }),
});

export type AdminAuditEntry = typeof AdminAuditEntrySchema.static;

export const AdminAuditPageSchema = t.Object({
	data: t.Array(AdminAuditEntrySchema),
	pagination: t.Object({
		total: t.Integer({ minimum: 0 }),
		page: t.Integer({ minimum: 1 }),
		limit: t.Integer({ minimum: 1 }),
		totalPages: t.Integer({ minimum: 0 }),
	}),
});

export type AdminAuditPage = typeof AdminAuditPageSchema.static;

export const AdminFilesystemDirectorySchema = t.Object({
	name: t.String(),
	path: t.String(),
});

export type AdminFilesystemDirectory = typeof AdminFilesystemDirectorySchema.static;

export const AdminFilesystemBrowseSchema = t.Object({
	currentPath: t.String(),
	parentPath: t.Nullable(t.String()),
	directories: t.Array(AdminFilesystemDirectorySchema),
	exists: t.Boolean(),
});

export type AdminFilesystemBrowse = typeof AdminFilesystemBrowseSchema.static;

export const AdminDatabaseBackupSchema = t.Object({
	fileName: t.String(),
	filePath: t.String(),
	sizeBytes: t.Integer({ minimum: 0 }),
	createdAt: t.String({ format: "date-time" }),
});

export type AdminDatabaseBackup = typeof AdminDatabaseBackupSchema.static;

export const AdminDatabaseBackupListSchema = t.Array(AdminDatabaseBackupSchema);
