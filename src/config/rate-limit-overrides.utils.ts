import { revisionMemo } from "@/config/settings-revision.cache";
import { systemSettingsStore } from "@/config/system-settings.store";
import { splitCommaList } from "@/utils/array.utils";

const WHOLE_NUMBER_PATTERN = /^[1-9][0-9]*$/;

/**
 * Route budgets an administrator may retune. Only read-only routes whose budget guards their own cost are listed:
 * login, two-factor, quick connect, sessions, setup, API keys, password, restore, install and plugin install buckets
 * stay fixed, so no setting can weaken them.
 */
export const TUNABLE_RATE_LIMIT_BUCKETS: ReadonlySet<string> = new Set([
	"admin-analytics",
	"admin-audit-summary",
	"admin-downloads-jobs",
	"admin-live-activity",
	"admin-processes-list",
	"admin-users-list",
	"admin-workers-list",
	"admin-workers-jobs-list",
	"admin-workers-operations-list",
	"admin-workers-watchdog",
	"library-scan-findings",
	"subtitle-content",
]);

/** A tuned budget may not exceed this many times the route's built-in budget, whatever is configured. */
export const RATE_LIMIT_OVERRIDE_CAP_MULTIPLIER = 10;

export interface RateLimitOverrideIssues {
	/** Entries that are not `name=max` pairs, or whose value is not a positive whole number. */
	malformed: string[];
	/** Entries that name a route whose budget cannot be tuned. */
	untunable: string[];
}

/** One `name=max` entry, or undefined when it is not exactly that with a positive whole-number max. */
function parseOverrideEntry(entry: string): { name: string; max: number } | undefined {
	const [name, value, ...rest] = entry.split("=").map((part) => part.trim());
	if (!name || value === undefined || rest.length > 0 || !WHOLE_NUMBER_PATTERN.test(value)) return undefined;

	return { name, max: Number(value) };
}

/**
 * Parsed `network.rateLimit.routeOverrides` for the current settings revision.
 * The store hands out the raw string on every read and parsing it per request
 * is pure allocation; the first valid entry per name wins, matching the
 * previous first-match scan. Invalid entries are ignored.
 */
const parsedOverrides = revisionMemo((): ReadonlyMap<string, number> => {
	const parsed = new Map<string, number>();
	for (const entry of splitCommaList(systemSettingsStore.get("network.rateLimit.routeOverrides"))) {
		const override = parseOverrideEntry(entry);
		if (override === undefined || parsed.has(override.name)) continue;

		parsed.set(override.name, override.max);
	}

	return parsed;
});

/** Reports what is wrong with a configured override string, so saving it can be refused with the bad entries. */
export function rateLimitOverrideIssues(raw: string): RateLimitOverrideIssues {
	const malformed: string[] = [];
	const untunable: string[] = [];

	for (const entry of splitCommaList(raw)) {
		const override = parseOverrideEntry(entry);
		if (override === undefined) {
			malformed.push(entry);
		} else if (!TUNABLE_RATE_LIMIT_BUCKETS.has(override.name)) {
			untunable.push(override.name);
		}
	}

	return { malformed, untunable };
}

/** The budget configured for a route bucket, or `undefined` when none applies. Invalid entries are ignored. */
export function tunedRouteMax(name: string, defaultMax: number): number | undefined {
	if (!TUNABLE_RATE_LIMIT_BUCKETS.has(name)) return undefined;

	const value = parsedOverrides().get(name);
	if (value === undefined) return undefined;

	return Math.min(value, defaultMax * RATE_LIMIT_OVERRIDE_CAP_MULTIPLIER);
}
