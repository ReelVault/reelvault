import { env } from "@/config/env.config";
import { SystemSettingsCreator } from "@/config/system-settings.utils";
import { splitCommaList } from "@/utils/array.utils";

const creator = SystemSettingsCreator("network");

export const NETWORK_SETTINGS_DEFINITIONS = {
	"network.allowedOrigins": creator.stringArray("network.allowedOrigins", splitCommaList(env.APP_ALLOWED_ORIGINS)),

	"network.trustLocalNetworks": creator.boolean("network.trustLocalNetworks", true),

	// Global per-IP request budget. A REELVAULT_RATE_LIMIT_* env hatch overrides it (platform.config.ts).
	"network.rateLimit.globalMax": creator.number("network.rateLimit.globalMax", 100, 1_000_000, 1000),
	"network.rateLimit.routeMultiplier": creator.number("network.rateLimit.routeMultiplier", 1, 10_000, 1),
	// Per-route budgets, `name=max,name=max`. Only tunable read-only buckets accept an entry; see rate-limit-overrides.ts.
	"network.rateLimit.routeOverrides": creator.string("network.rateLimit.routeOverrides", ""),
} as const;
