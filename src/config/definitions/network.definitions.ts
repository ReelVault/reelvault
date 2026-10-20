import { env } from "@/config/env.config";
import { SystemSettingsCreator } from "@/config/system-settings.utils";
import { splitCommaList } from "@/utils/array.utils";

function parseInitialOrigins(value?: string): string[] {
	return splitCommaList(value);
}

const creator = SystemSettingsCreator("network");

export const NETWORK_SETTINGS_DEFINITIONS = {
	"network.allowedOrigins": creator.stringArray("network.allowedOrigins", parseInitialOrigins(env.APP_ALLOWED_ORIGINS)),

	"network.trustLocalNetworks": creator.boolean("network.trustLocalNetworks", true),

	// Global per-IP request budget. Env hatches (REELVAULT_RATE_LIMIT_*) seed
	// nothing here — they only exist for load tests and stay env-only.
	"network.rateLimit.globalMax": creator.number("network.rateLimit.globalMax", 100, 1_000_000, 1000),
	"network.rateLimit.routeMultiplier": creator.number("network.rateLimit.routeMultiplier", 1, 10_000, 1),
	// Per-route budgets, `name=max,name=max`. Only tunable read-only buckets accept an entry; see rate-limit-overrides.ts.
	"network.rateLimit.routeOverrides": creator.string("network.rateLimit.routeOverrides", ""),
} as const;
