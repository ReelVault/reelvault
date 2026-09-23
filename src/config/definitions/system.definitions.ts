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

	"system.database.operationRetentionDays": creator.number("system.database.operationRetentionDays", 1, 365, 7),
	"system.logs.retentionDays": creator.number("system.logs.retentionDays", 1, 365, 7),

	"api.pagination.defaultLimit": creator.number("api.pagination.defaultLimit", 5, 100, 20),
} as const;
