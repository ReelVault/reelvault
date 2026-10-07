import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { ValidationError } from "@/utils/errors";
import type { MemoryCache } from "@/utils/memory-cache";

const IPV4_MAPPED_IPV6_REGEX = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/;
const IPV6_ZONE_ID_REGEX = /^%.*$/;

// ─── CIDR-based IPv4 classification ──────────────────────────────────────────

interface Ipv4Range {
	/** Precomputed network/mask pair — classification must not re-shift per call. */
	network: number;
	mask: number;
}

function ipv4ToInt(ip: string): number {
	const parts = ip.split(".").map((part) => Number.parseInt(part, 10));
	const [a = 0, b = 0, c = 0, d = 0] = parts;

	return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

function parseIpv4Range(cidr: string): Ipv4Range {
	const [base, bitsText] = cidr.split("/");
	const parsedBase = ipv4ToInt(base ?? "0.0.0.0");
	const bits = Number.parseInt(bitsText ?? "32", 10);
	const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;

	return { network: (parsedBase & mask) >>> 0, mask };
}

// RFC1918 + loopback + link-local + CGNAT + documentation/benchmark/multicast/reserved.
const NON_PUBLIC_IPV4_RANGES = [
	"0.0.0.0/8",
	"10.0.0.0/8",
	"100.64.0.0/10",
	"127.0.0.0/8",
	"169.254.0.0/16",
	"172.16.0.0/12",
	"192.0.0.0/24",
	"192.0.2.0/24",
	"192.88.99.0/24",
	"192.168.0.0/16",
	"198.18.0.0/15",
	"198.51.100.0/24",
	"203.0.113.0/24",
	"224.0.0.0/4",
	"240.0.0.0/4",
].map((item) => parseIpv4Range(item));

function isPublicIpv4(ip: string): boolean {
	const value = ipv4ToInt(ip);
	for (const range of NON_PUBLIC_IPV4_RANGES) {
		// Both sides must be unsigned — the sign bit is set for 128.0.0.0+.
		if ((value & range.mask) >>> 0 === range.network) return false;
	}

	return true;
}

/**
 * Only global-unicast IPv6 (`2000::/3`) is allowed. That rejects loopback,
 * unspecified, unique-local (`fc00::/7`), link-local (`fe80::/10`), multicast
 * and IPv4-mapped forms (handled via the embedded IPv4).
 */
function isPublicIpv6(ip: string): boolean {
	const normalized = ip.toLowerCase();
	if (normalized.includes("%")) return false;

	const mapped = IPV4_MAPPED_IPV6_REGEX.exec(normalized);
	if (mapped?.[1]) return isPublicIpv4(mapped[1]);

	// Special-purpose ranges that sit INSIDE the global-unicast 2000::/3 block and
	// therefore need explicit rejection: documentation, 6to4 (2002::/16 — embeds
	// an IPv4 literal such as 127.0.0.1 / 169.254.169.254), Teredo (2001::/32),
	// benchmarking (2001:2::/48) and the 3fff::/20 + 5f00::/16 allocations.
	if (normalized.startsWith("2001:db8")) return false;

	if (normalized.startsWith("2002:")) return false;

	if (normalized.startsWith("2001:2:")) return false;

	if (normalized.startsWith("3fff:")) return false;

	if (normalized.startsWith("5f00:")) return false;

	const groups = normalized.split(":");
	const first = Number.parseInt(groups[0] ?? "0", 16);
	// Teredo 2001::/32 — first hextet 0x2001, second hextet 0x0000.
	if (first === 0x2001) {
		const secondText = groups[1] ?? "";
		const second = secondText === "" ? 0 : Number.parseInt(secondText, 16);
		if (second === 0) return false;
	}

	return first >= 0x2000 && first <= 0x3fff;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Classifies an IP address string as a public (globally routable) address. */
export function isPublicAddress(ip: string): boolean {
	const family = isIP(ip);
	if (family === 4) return isPublicIpv4(ip);

	if (family === 6) return isPublicIpv6(ip);

	return false;
}

/**
 * SSRF guard for outbound fetches driven by user/provider-supplied URLs.
 * A URL qualifies only when its scheme is allowed AND every address the
 * hostname resolves to is globally routable — private ranges, loopback,
 * link-local and DNS-rebinding-style mappings are rejected before any
 * request is made.
 */
function isPublicIp(address: string): boolean {
	const ip = address.toLowerCase().replace(IPV6_ZONE_ID_REGEX, "");
	if (ip.includes(":")) return isPublicIpv6(ip);

	return isPublicIpv4(ip);
}

interface ResolvedTarget {
	url: URL;
	address: string;
}

/** Bracketed IPv6 literals are valid URL hostnames but not valid lookup names. */
const BRACKET_WRAP = /^\[|\]$/g;

function normalizeHostname(hostname: string): string {
	return hostname.toLowerCase().replace(BRACKET_WRAP, "");
}

export interface GuardedFetchOptions extends RequestInit {
	/** Schemes allowed on every hop. Defaults to https only. */
	allowedProtocols?: readonly string[] | undefined;
	/** Redirect hops followed after re-validating each target. Defaults to 4. */
	maxRedirects?: number | undefined;
	/**
	 * Extra per-host check (e.g. an allowlist) applied to the normalized
	 * hostname before DNS resolution. Throw to reject the host.
	 */
	assertHostAllowed?: ((hostname: string) => void) | undefined;
	/**
	 * Optional shared resolved-address cache. Callers own its bounds/TTL; it
	 * keeps repeat fetches from re-resolving while staying short enough to
	 * defeat DNS rebinding.
	 */
	dnsCache?: MemoryCache<string[]> | undefined;
}

const DEFAULT_ALLOWED_PROTOCOLS = ["https:"] as const;
const DEFAULT_MAX_REDIRECTS = 4;
const TRAILING_COLON = /:$/;

/** Fetch-spec redirect statuses — every hop is re-validated before it is followed. */
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

async function resolveHostAddresses(hostname: string, dnsCache: MemoryCache<string[]> | undefined): Promise<string[]> {
	const cached = dnsCache?.get(hostname);
	if (cached) return cached;

	const results: LookupAddress[] = await lookup(hostname, { all: true, order: "ipv4first" });
	const addresses = results.map((entry) => entry.address);
	dnsCache?.set(hostname, addresses);

	return addresses;
}

/**
 * Validates + resolves a URL to a single public address. Returning the address
 * lets callers PIN the connection to the vetted IP, closing the DNS-rebinding
 * TOCTOU window between validation and `fetch()`.
 */
async function resolvePublicTarget(rawUrl: string, options: GuardedFetchOptions): Promise<ResolvedTarget> {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch {
		throw new ValidationError("Download URL is not a valid URL", { code: "download.invalid_url" });
	}

	const allowedProtocols = options.allowedProtocols ?? DEFAULT_ALLOWED_PROTOCOLS;
	if (!allowedProtocols.includes(parsed.protocol)) {
		const display = allowedProtocols.map((protocol) => protocol.replace(TRAILING_COLON, "")).join(", ");
		throw new ValidationError(`Only ${display} downloads are allowed, got: ${parsed.protocol}`, {
			code: "download.unsupported_protocol",
		});
	}

	if (parsed.username || parsed.password) {
		throw new ValidationError("Download URL must not contain credentials", { code: "download.invalid_url" });
	}

	const host = normalizeHostname(parsed.hostname);
	options.assertHostAllowed?.(host);

	let addresses: string[];
	try {
		addresses = await resolveHostAddresses(host, options.dnsCache);
	} catch {
		throw new ValidationError(`Download host does not resolve: ${parsed.hostname}`, { code: "download.host_unresolved" });
	}

	if (addresses.length === 0 || addresses.some((address) => !isPublicIp(address))) {
		throw new ValidationError("Download host resolves to a non-public address", { code: "download.host_blocked" });
	}

	const chosen = addresses.find((address) => !address.includes(":")) ?? addresses[0];
	if (!chosen) {
		throw new ValidationError("Download host resolves to a non-public address", { code: "download.host_blocked" });
	}

	return { url: parsed, address: chosen };
}

/** Rewrites a URL to connect to a specific (already-vetted) IP address. */
export function pinUrlToAddress(url: URL, address: string): string {
	const host = address.includes(":") ? `[${address}]` : address;
	const port = url.port ? `:${url.port}` : "";

	return `${url.protocol}//${host}${port}${url.pathname}${url.search}`;
}

/**
 * Fetch with the SSRF guard applied to every hop: manual redirect handling so
 * a public first hop cannot bounce fetch() into a private address. The
 * connection is pinned to the validated IP (no second DNS resolution), and
 * credentials supplied via `headers` are dropped on cross-origin hops so a
 * redirect cannot exfiltrate a bearer token.
 */
export async function guardedFetch(url: string, options: GuardedFetchOptions = {}): Promise<Response> {
	const { allowedProtocols, maxRedirects, assertHostAllowed, dnsCache, ...init } = options;
	const guardOptions: GuardedFetchOptions = { allowedProtocols, maxRedirects, assertHostAllowed, dnsCache };
	const redirectLimit = maxRedirects ?? DEFAULT_MAX_REDIRECTS;

	const initial = await resolvePublicTarget(url, guardOptions);
	let current = initial;
	let currentInit = init;
	for (let hop = 0; ; hop++) {
		const sameOrigin = current.url.origin === initial.url.origin;
		const headers = headersForHop(currentInit.headers, sameOrigin);
		// `Host` must match the real hostname while we dial the vetted IP; TLS SNI
		// is set to the same name so certificate validation is unchanged.
		const pinnedHeaders = new Headers(headers ?? undefined);
		pinnedHeaders.set("Host", current.url.host);

		const response = await fetch(pinUrlToAddress(current.url, current.address), {
			...currentInit,
			headers: pinnedHeaders,
			redirect: "manual",
			tls: { serverName: current.url.hostname },
		});
		if (!REDIRECT_STATUS.has(response.status)) return response;

		const location = response.headers.get("location");
		if (!location) return response;

		if (hop >= redirectLimit) throw new ValidationError("Too many download redirects", { code: "download.too_many_redirects" });

		// Match the fetch spec: 303 (and 301/302 for non-GET/HEAD) downgrade to GET.
		const method = (currentInit.method ?? "GET").toUpperCase();
		if (response.status === 303 || ((response.status === 301 || response.status === 302) && method !== "GET" && method !== "HEAD")) {
			currentInit = { ...currentInit, method: "GET", body: null };
		}

		current = await resolvePublicTarget(new URL(location, current.url).href, guardOptions);
	}
}

/** Headers that must never be replayed to a different origin on redirect. */
const CROSS_ORIGIN_STRIPPED_HEADERS = ["authorization", "cookie", "proxy-authorization", "x-api-key", "x-auth-token", "x-goog-api-key"];

function headersForHop(headers: HeadersInit | undefined, sameOrigin: boolean): Headers | undefined {
	if (!headers) return undefined;

	const merged = new Headers(headers);
	if (!sameOrigin) {
		for (const name of CROSS_ORIGIN_STRIPPED_HEADERS) merged.delete(name);
	}

	return merged;
}
