import { isIP } from "node:net";
import { env } from "@/env";
import { serverConfig } from "@/server.config";
import { trimAndFilter, unique } from "@/utils/array.utils";
import { ValidationError } from "@/utils/errors";
import { MemoryCache } from "@/utils/memory-cache";
import { isPublicAddress } from "@/utils/url-guard.utils";

const RAW_IPV4_PATTERN = /^(\d{1,3}\.){3}\d{1,3}$/;
const HTTP_URL_PATTERN = /^(https?:\/\/)([^/?]*)(.*)$/;
const IP_SHAPED_HOST_PATTERN = /^[0-9.:*]+$/;
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Bounded cache for URL origin parsing — avoids repeated `new URL()` on every request. */
const parsedUrlCache = new MemoryCache<URL>({ ttlMs: -1, maxSize: 128, name: "parsed-url" });

function parseOriginUrl(origin: string): URL | undefined {
	const cached = parsedUrlCache.get(origin);
	if (cached !== null) return cached;

	try {
		const url = new URL(origin);
		parsedUrlCache.set(origin, url);

		return url;
	} catch {
		return undefined;
	}
}

/**
 * Shared URL / HTTP utilities used across middleware and integrations.
 */

/** Extract the numeric status from Elysia's `set.status`, defaulting to `fallback`. */
export function getResponseStatus(set: { status?: number | string }, fallback = 200): number {
	return typeof set.status === "number" ? set.status : fallback;
}

/**
 * Extracts the pathname from a full URL string without constructing a URL
 * object — avoids allocations on the hot request path.
 *
 * @example
 * getPathname("http://localhost:3000/v1/health?foo=bar") // "/v1/health"
 */
export function getPathname(url: string): string {
	const start = url.indexOf("/", 8);
	if (start === -1) return "/";

	const end = url.indexOf("?", start);

	return end === -1 ? url.slice(start) : url.slice(start, end);
}

/**
 * Normalizes a raw origin/URL string (with or without scheme) to a `URL`,
 * defaulting to `http:` when no scheme is given.
 *
 * @throws {Error} When the resulting URL uses an unsupported protocol.
 */
export function normalizeHttpUrl(value: string): URL {
	const url = new URL(value.includes("://") ? value : `http://${value}`);
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new ValidationError(`URL must use HTTP or HTTPS, got: ${url.protocol}`, { code: "http.invalid_protocol" });
	}

	return url;
}

/**
 * Parses a comma-separated list or array of origins/patterns into a clean array.
 */
export function parseAllowedOrigins(value?: string | string[]): string[] {
	if (!value) return [];

	const rawList = Array.isArray(value) ? value : value.split(",");

	const origins = trimAndFilter(rawList);

	return unique(origins);
}

const LOCAL_DOMAIN_SUFFIXES = [".lan", ".local", ".home", ".home.arpa", ".internal"];
const COOKIE_DOMAIN_REGEX = /;\s*domain=/i;

export function rewriteCookieDomain(response: Response, origin: string | null | undefined): Response {
	// Inject Domain into every Set-Cookie the auth handler emits so the
	// session cookie is shared between api.rv.lan and rv.lan (or any other
	// subdomain pair) without requiring explicit APP_COOKIE_DOMAIN config.
	const domain = getCookieDomainFromOrigin(origin);
	if (!domain) return response;

	const setCookies = response.headers.getSetCookie();
	if (setCookies.length === 0) return response;

	const newHeaders = new Headers(response.headers);
	newHeaders.delete("set-cookie");
	for (const cookie of setCookies) {
		// Only add Domain if one isn't already present.
		const hasDomain = COOKIE_DOMAIN_REGEX.test(cookie);
		newHeaders.append("set-cookie", hasDomain ? cookie : `${cookie}; Domain=${domain}`);
	}

	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers: newHeaders,
	});
}

/**
 * Derives the correct `Domain` attribute value for a Set-Cookie header based
 * on the browser `Origin` request header.
 *
 * **Why:** When the API lives on `api.rv.lan` and the frontend on `rv.lan`,
 * a cookie set without a `Domain` attribute is scoped to `api.rv.lan` only.
 * By setting `Domain=.rv.lan` the cookie is automatically shared with `rv.lan`
 * and all other subdomains — no static configuration required.
 *
 * The domain is only set when the origin is **allowed** (trusted local network,
 * `APP_PUBLIC_URL`, `APP_ALLOWED_ORIGINS`, or `network.allowedOrigins` from the
 * admin panel / system settings store). Untrusted origins never receive a
 * domain-scoped cookie.
 *
 * `APP_COOKIE_DOMAIN` (if set) acts as an explicit override that skips all checks.
 *
 * | Origin                        | Returns          |
 * |-------------------------------|------------------|
 * | `https://rv.lan`              | `.rv.lan`        |
 * | `https://rv.domena.pl`        | `.rv.domena.pl`  |
 * | `http://192.168.0.42:3000`    | `undefined`      |
 * | `http://localhost:3000`       | `undefined`      |
 * | `https://evil.com`            | `undefined`      |
 *
 * Raw IPs and `localhost` return `undefined` because browsers treat cookies as
 * port-independent for the same hostname, so cross-port sharing already works.
 */
export function getCookieDomainFromOrigin(origin: string | null | undefined): string | undefined {
	// Explicit env override always wins — skips all dynamic checks.
	if (env.APP_COOKIE_DOMAIN) return env.APP_COOKIE_DOMAIN;

	if (!origin) return undefined;

	// Only set a shared cookie domain for origins that are actually trusted.
	// isOriginAllowed reads network.allowedOrigins from the system settings store
	// (admin panel) at call time, so changes take effect without a server restart.
	if (!isOriginAllowed(origin)) return undefined;

	const parsed = parseOriginUrl(origin);
	if (!parsed) return undefined;

	const { hostname } = parsed;

	// localhost / loopback — port-independent cookies already work
	if (LOOPBACK_HOSTNAMES.has(hostname)) {
		return undefined;
	}

	// Raw IPv4 address — same logic (port-independent, no domain attr needed)
	if (RAW_IPV4_PATTERN.test(hostname)) return undefined;

	// Named domain (rv.lan, rv.domena.pl, …) — scope to parent domain
	return `.${hostname}`;
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
	if (LOOPBACK_HOSTNAMES.has(lower)) {
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
	const dynamicOrigins = serverConfig.network.allowedOrigins;
	if (Array.isArray(dynamicOrigins) && dynamicOrigins.length > 0) {
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
let cachedDynamicKey: string | undefined;
let cachedDynamicResult: string[] | undefined;

/**
 * Builds standard wildcard patterns and configured origins for Better Auth and CORS fallback.
 * Static patterns/env origins are computed once; dynamic origins are merged per call
 * only when present.
 */
export function getTrustedOriginPatterns(): string[] {
	if (!staticTrustedOriginPatterns) {
		const base = [...STATIC_TRUSTED_ORIGIN_PATTERNS];
		const publicOrigin = getPublicUrlOrigin();
		if (publicOrigin) base.push(publicOrigin);

		base.push(...envAllowedOrigins);
		staticTrustedOriginPatterns = unique(base);
	}

	const dynamicOrigins = serverConfig.network.allowedOrigins;
	if (!Array.isArray(dynamicOrigins) || dynamicOrigins.length === 0) {
		return staticTrustedOriginPatterns;
	}

	const dynamicKey = `${dynamicOrigins.length}:${dynamicOrigins.join(",")}`;
	if (dynamicKey === cachedDynamicKey && cachedDynamicResult) return cachedDynamicResult;

	const result = unique([...staticTrustedOriginPatterns, ...dynamicOrigins]);
	cachedDynamicKey = dynamicKey;
	cachedDynamicResult = result;

	return result;
}
