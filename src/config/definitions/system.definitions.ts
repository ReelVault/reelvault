import { SystemSettingsCreator } from "../system-settings.utils";

const creator = SystemSettingsCreator("system");

export const SYSTEM_SETTINGS_DEFINITIONS = {
	"collections.minimalToShow": creator.number("collections.minimalToShow", 1, Number.MAX_SAFE_INTEGER, 2),

	"auth.allowRegistration": creator.boolean("auth.allowRegistration", false),

	"plugins.providers.detailsCacheTtlMs": creator.number("plugins.providers.detailsCacheTtlMs", 10_000, Number.MAX_SAFE_INTEGER, 300_000),
	"plugins.http.allowedDomains": creator.string("plugins.http.allowedDomains", ""),

	// Aggregation strategy for the metadata card rating. "votes" weights each source by its
	// vote count (log-scaled), "simple" averages every source equally.
	"metadata.ratingAggregation": creator.enum("metadata.ratingAggregation", ["votes", "simple"], "votes"),

	// Titles scoring below this threshold are listed as low-confidence matches.
	"metadata.minMatchScore": creator.number("metadata.minMatchScore", 0.45, 1, 0.75),

	"system.database.operationRetentionDays": creator.number("system.database.operationRetentionDays", 1, 365, 7),
	"system.logs.retentionDays": creator.number("system.logs.retentionDays", 1, 365, 7),

	// Require every account to have TOTP configured before sign-in is accepted.
	"auth.enforceTwoFactor": creator.boolean("auth.enforceTwoFactor", false),
	"auth.sessionLifetimeDays": creator.number("auth.sessionLifetimeDays", 1, 365, 7),
	"auth.rateLimit.loginAccountMaxAttempts": creator.number("auth.rateLimit.loginAccountMaxAttempts", 3, 100, 10),

	// 0 keeps the full play history; a positive value prunes older rows in the
	// daily database cleanup (history feeds analytics, insights and wrapped).
	"system.database.watchedHistoryRetentionDays": creator.number("system.database.watchedHistoryRetentionDays", 0, 3650, 0),
	// Audit rows carry JSON snapshots and previously grew unbounded; the daily
	// cleanup prunes rows older than this. 0 = keep everything.
	"system.database.auditRetentionDays": creator.number("system.database.auditRetentionDays", 0, 3650, 180),
	"system.database.backupRetentionCount": creator.number("system.database.backupRetentionCount", 1, 100, 7),

	// Default look-back for the admin analytics dashboard when no explicit range
	// is requested (the "all" view).
	"system.analytics.windowDays": creator.number("system.analytics.windowDays", 7, 3650, 90),

	"api.pagination.defaultLimit": creator.number("api.pagination.defaultLimit", 5, 100, 20),
} as const;
