import { isIP } from "node:net";
import { env } from "@/config/env.config";
import { serverConfig } from "@/config/server/server.config";
import { systemSettingsStore } from "@/config/system-settings.store";
import { unique } from "@/utils/array.utils";
import { escapeRegex, normalizeHttpUrl, parseAllowedOrigins, parseOriginUrl } from "@/utils/http.utils";
import { MemoryCache } from "@/utils/memory.cache";
import { isPublicAddress } from "@/utils/url-guard.utils";

/**
 * Which browser origins the server trusts: the local network, the configured public URL,
 * the admin-managed allowlist and the native client shells. Used by CORS, auth cookies and
 * the Better Auth trusted-origin list.
 */

const HTTP_URL_PATTERN = /^(https?:\/\/)([^/?]*)(.*)$/;
const IP_SHAPED_HOST_PATTERN = /^[0-9.:*]+$/;
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const LOCAL_DOMAIN_SUFFIXES = [".lan", ".local", ".home", ".home.arpa", ".internal"];

export function isLoopbackHost(hostname: string): boolean {
	return LOOPBACK_HOSTNAMES.has(hostname);
}

/** True when the matcher can use an allowed-origin entry: a wildcard pattern or
 * an http(s) URL/host. A typo (spaces, stray scheme) would otherwise silently
 * never match — boot warns about every entry this rejects. */
export function isUsableOriginEntry(value: string): boolean {
	const trimmed = value.trim();
	if (trimmed.length === 0) return false;

	if (trimmed.includes("*")) return true;

	try {
		return normalizeHttpUrl(trimmed).hostname.length > 0;
	} catch {
		return false;
	}
}

/** Single source of truth for non-routable IPv4 ranges: the `url-guard` CIDR table. */
function isPrivateIpv4(ip: string): boolean {
	return isIP(ip) === 4 && !isPublicAddress(ip);
}

/**
 * Checks if a given hostname belongs to a local private network or loopback.
 * Results are memoized because hostnames repeat heavily on the request path.
 */
const localHostCache = new MemoryCache<boolean>({ ttlMs: -1, maxSize: 500, name: "local-host" });

export function isLocalNetworkHost(hostname: string): boolean {
	const cached = localHostCache.get(hostname);
	if (cached !== null) return cached;

	const result = computeLocalNetworkHost(hostname);
	localHostCache.set(hostname, result);

	return result;
}

function computeLocalNetworkHost(hostname: string): boolean {
	const lower = hostname.toLowerCase();
	if (isLoopbackHost(lower)) {
		return true;
	}

	if (isPrivateIpv4(lower)) {
		return true;
	}

	return LOCAL_DOMAIN_SUFFIXES.some((suffix) => lower.endsWith(suffix) || lower === suffix.slice(1));
}

const regexPatternCache = new MemoryCache<RegExp>({ ttlMs: -1, maxSize: 500, name: "regex-pattern" });
const patternOriginCache = new MemoryCache<string>({ ttlMs: -1, maxSize: 500, name: "pattern-origin" });

/**
 * Returns the cached `URL.origin` for a static pattern, avoiding a `new URL`
 * allocation per request for the same pattern.
 */
function getPatternOrigin(pattern: string): string | null {
	const cached = patternOriginCache.get(pattern);
	if (cached !== null) return cached || null;

	let origin = "";
	try {
		origin = normalizeHttpUrl(pattern).origin;
	} catch {
		// Invalid pattern yields no cached origin.
	}

	patternOriginCache.set(pattern, origin);

	return origin || null;
}

/**
 * Converts a wildcard string pattern (e.g. `http://*.ts:*` or `*.lan:3000`) into a RegExp.
 *
 * Semantics by position: in the HOST, `*` matches a single DNS label — except in
 * IP-shaped patterns (`192.168.*`), where it matches the rest of the numeric
 * host. This keeps `http://192.168.*:*` from also matching attacker-controlled
 * `http://192.168.evil.com`. In the PATH, `*` matches anything.
 */
export function wildcardPatternToRegex(pattern: string): RegExp {
	const trimmed = pattern.trim();
	const cached = regexPatternCache.get(trimmed);
	if (cached) return cached;

	const withScheme = trimmed.includes("://") ? trimmed : `https?://${trimmed}`;

	const match = withScheme.match(HTTP_URL_PATTERN);
	let regexString: string;
	if (!match) {
		regexString = `^${escapeRegex(withScheme).replace(/\\\*/g, ".*")}$`;
	} else {
		const scheme = match[1] ?? "";
		const host = match[2] ?? "";
		const rest = match[3] ?? "";
		const ipShaped = IP_SHAPED_HOST_PATTERN.test(host);
		const wildcard = ipShaped ? "[0-9.]*" : "[^.]*";
		regexString = `^${escapeRegex(scheme)}${escapeRegex(host).replace(/\\\*/g, wildcard)}${escapeRegex(rest).replace(/\\\*/g, ".*")}$`;
	}

	const compiled = new RegExp(regexString, "i");
	regexPatternCache.set(trimmed, compiled);

	return compiled;
}

function matchOriginRule(origin: string, rule: string | RegExp): boolean {
	if (rule instanceof RegExp) return rule.test(origin);

	if (rule === origin) return true;

	if (rule.includes("*")) return wildcardPatternToRegex(rule).test(origin);

	return getPatternOrigin(rule) === origin;
}

function matchesOriginRules(origin: string, rules: ReadonlyArray<string | RegExp>): boolean {
	for (const rule of rules) {
		if (matchOriginRule(origin, rule)) return true;
	}

	return false;
}

// Static origin lists derived from env — computed once, `env` never changes at runtime.
const envAllowedOrigins = parseAllowedOrigins(env.APP_ALLOWED_ORIGINS);
let publicUrlOriginCache: string | null | undefined;

function getPublicUrlOrigin(): string | null {
	if (publicUrlOriginCache === undefined) {
		try {
			publicUrlOriginCache = env.APP_PUBLIC_URL ? normalizeHttpUrl(env.APP_PUBLIC_URL).origin : null;
		} catch {
			publicUrlOriginCache = null;
		}
	}

	return publicUrlOriginCache;
}

/**
 * Origins of the native client shells, allowed before the general protocol
 * allowlist (they never share the server's scheme/host):
 * - Tauri desktop: `tauri://localhost` (macOS/Linux) or `http://tauri.localhost` (Windows).
 * - Capacitor mobile: Android WebView serves over https with the appId as
 *   hostname (e.g. `https://pl.reelvault.mobile`), iOS over `capacitor://localhost`.
 * All of them must pass CORS **with credentials**, so they need to be explicit.
 */
function isNativeShellOrigin(parsed: URL): boolean {
	if (parsed.protocol === "tauri:" && parsed.hostname === "localhost") return true;

	if (parsed.protocol === "http:" && parsed.hostname === "tauri.localhost") return true;

	if (parsed.protocol === "capacitor:") return true;

	return parsed.protocol === "https:" && (parsed.hostname === "localhost" || parsed.hostname.endsWith(".reelvault.mobile"));
}

/**
 * Checks if the requested origin is allowed based on dynamic settings, LAN trust, and env config.
 */
export function isOriginAllowed(reqOrigin: string | null | undefined, explicitAllowedOrigins?: ReadonlyArray<string | RegExp>): boolean {
	if (!reqOrigin) return false;

	const parsed = parseOriginUrl(reqOrigin);
	if (!parsed) return false;

	// URL.origin is "null" for non-special schemes, so compare protocol + host.
	if (isNativeShellOrigin(parsed)) {
		return true;
	}

	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return false;
	}

	// 1. Dynamic local network trust (localhost, 192.168.x.x, *.lan, *.local, etc.)
	if (serverConfig.network.trustLocalNetworks && isLocalNetworkHost(parsed.hostname)) {
		return true;
	}

	// 2. Check APP_PUBLIC_URL
	const publicOrigin = getPublicUrlOrigin();
	if (publicOrigin && publicOrigin === parsed.origin) {
		return true;
	}

	// 3. Dynamic allowed origins from database / system settings store
	const dynamicOrigins = dynamicAllowedOrigins();
	if (dynamicOrigins.length > 0) {
		if (matchesOriginRules(reqOrigin, dynamicOrigins)) {
			return true;
		}
	}

	// 4. Configured origins from env.APP_ALLOWED_ORIGINS
	if (envAllowedOrigins.length > 0 && matchesOriginRules(reqOrigin, envAllowedOrigins)) {
		return true;
	}

	// 5. Explicitly passed origins/regexes (if provided)
	if (explicitAllowedOrigins && explicitAllowedOrigins.length > 0) {
		if (matchesOriginRules(reqOrigin, explicitAllowedOrigins)) return true;
	}

	return false;
}

const STATIC_TRUSTED_ORIGIN_PATTERNS: readonly string[] = [
	"tauri://localhost",
	"http://tauri.localhost",
	"capacitor://localhost",
	"https://*.reelvault.mobile",
	"http://localhost:*",
	"https://localhost:*",
	"http://127.0.0.1:*",
	"https://127.0.0.1:*",
	"http://10.*:*",
	"https://10.*:*",
	"http://172.16.*:*",
	"http://172.17.*:*",
	"http://172.18.*:*",
	"http://172.19.*:*",
	"http://172.20.*:*",
	"http://172.21.*:*",
	"http://172.22.*:*",
	"http://172.23.*:*",
	"http://172.24.*:*",
	"http://172.25.*:*",
	"http://172.26.*:*",
	"http://172.27.*:*",
	"http://172.28.*:*",
	"http://172.29.*:*",
	"http://172.30.*:*",
	"http://172.31.*:*",
	"http://192.168.*:*",
	"https://192.168.*:*",
	"http://*.lan:*",
	"https://*.lan:*",
	"http://*.local:*",
	"https://*.local:*",
	"http://*.home:*",
	"https://*.home:*",
	"http://*.home.arpa:*",
	"https://*.home.arpa:*",
	"http://*.internal:*",
	"https://*.internal:*",
];

let staticTrustedOriginPatterns: string[] | undefined;
let cachedDynamicOriginsRevision = -1;
let cachedDynamicOrigins: readonly string[] = [];
let cachedDynamicPatternsRevision = -1;
let cachedDynamicPatterns: string[] | undefined;

/**
 * Dynamic allowed origins for the current settings revision. The store clones
 * the array on every read, so cache the clone until the revision moves —
 * this runs on every request carrying an `Origin` header.
 */
function dynamicAllowedOrigins(): readonly string[] {
	const revision = systemSettingsStore.revision;
	if (revision !== cachedDynamicOriginsRevision) {
		cachedDynamicOrigins = serverConfig.network.allowedOrigins;
		cachedDynamicOriginsRevision = revision;
	}

	return cachedDynamicOrigins;
}

/**
 * Builds standard wildcard patterns and configured origins for Better Auth and CORS fallback.
 * Static patterns/env origins are computed once; the merged dynamic list is
 * cached per settings revision.
 */
export function getTrustedOriginPatterns(): string[] {
	if (!staticTrustedOriginPatterns) {
		const base = [...STATIC_TRUSTED_ORIGIN_PATTERNS];
		const publicOrigin = getPublicUrlOrigin();
		if (publicOrigin) base.push(publicOrigin);

		base.push(...envAllowedOrigins);
		staticTrustedOriginPatterns = unique(base);
	}

	const revision = systemSettingsStore.revision;
	if (revision !== cachedDynamicPatternsRevision || !cachedDynamicPatterns) {
		const dynamicOrigins = dynamicAllowedOrigins();
		cachedDynamicPatterns =
			dynamicOrigins.length === 0 ? staticTrustedOriginPatterns : unique([...staticTrustedOriginPatterns, ...dynamicOrigins]);
		cachedDynamicPatternsRevision = revision;
	}

	return cachedDynamicPatterns;
}
