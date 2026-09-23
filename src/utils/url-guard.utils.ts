import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { ValidationError } from "@/utils/errors";

const IPV4_MAPPED_IPV6_REGEX = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/;
const IPV6_ZONE_ID_REGEX = /^%.*$/;

// ─── CIDR-based IPv4 classification ──────────────────────────────────────────

interface Ipv4Range {
	base: number;
	bits: number;
}

function ipv4ToInt(ip: string): number {
	const parts = ip.split(".").map((part) => Number.parseInt(part, 10));
	const [a = 0, b = 0, c = 0, d = 0] = parts;

	return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

function parseIpv4Range(cidr: string): Ipv4Range {
	const [base, bitsText] = cidr.split("/");

	return { base: ipv4ToInt(base ?? "0.0.0.0"), bits: Number.parseInt(bitsText ?? "32", 10) };
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
		const mask = range.bits === 0 ? 0 : (0xffffffff << (32 - range.bits)) >>> 0;
		if ((value & mask) === (range.base & mask)) return false;
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
 * A URL qualifies only when it is https AND every address the hostname
 * resolves to is globally routable — private ranges, loopback, link-local
 * and DNS-rebinding-style mappings are rejected before any request is made.
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

/**
 * Validates + resolves a URL to a single public address. Returning the address
 * lets callers PIN the connection to the vetted IP, closing the DNS-rebinding
 * TOCTOU window between validation and `fetch()`.
 */
async function resolvePublicTarget(rawUrl: string): Promise<ResolvedTarget> {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch {
		throw new ValidationError("Download URL is not a valid URL", { code: "download.invalid_url" });
	}

	if (parsed.protocol !== "https:") {
		throw new ValidationError(`Only https downloads are allowed, got: ${parsed.protocol}`, { code: "download.unsupported_protocol" });
	}

	if (parsed.username || parsed.password) {
		throw new ValidationError("Download URL must not contain credentials", { code: "download.invalid_url" });
	}

	let addresses: LookupAddress[] = [];
	try {
		addresses = await lookup(parsed.hostname, { all: true, order: "ipv4first" });
	} catch {
		throw new ValidationError(`Download host does not resolve: ${parsed.hostname}`, { code: "download.host_unresolved" });
	}

	if (addresses.length === 0 || addresses.some((entry) => !isPublicIp(entry.address))) {
		throw new ValidationError("Download host resolves to a non-public address", { code: "download.host_blocked" });
	}

	const chosen = addresses.find((entry) => entry.family === 4) ?? addresses[0];
	if (!chosen) {
		throw new ValidationError("Download host resolves to a non-public address", { code: "download.host_blocked" });
	}

	return { url: parsed, address: chosen.address };
}

export async function assertPublicHttpUrl(rawUrl: string): Promise<URL> {
	return (await resolvePublicTarget(rawUrl)).url;
}

/** Rewrites a URL to connect to a specific (already-vetted) IP address. */
export function pinUrlToAddress(url: URL, address: string): string {
	const host = address.includes(":") ? `[${address}]` : address;
	const port = url.port ? `:${url.port}` : "";

	return `${url.protocol}//${host}${port}${url.pathname}${url.search}`;
}

/** Max redirects followed while each hop is re-validated. */
const MAX_REDIRECTS = 4;

/**
 * Fetch with the SSRF guard applied to every hop: manual redirect handling so
 * a public first hop cannot bounce fetch() into a private address. The
 * connection is pinned to the validated IP (no second DNS resolution), and
 * credentials supplied via `headers` are dropped on cross-origin hops so a
 * redirect cannot exfiltrate a bearer token.
 */
export async function guardedFetch(url: string, init?: { signal?: AbortSignal; headers?: HeadersInit }): Promise<Response> {
	const initial = await resolvePublicTarget(url);
	let current = initial;
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		const sameOrigin = current.url.origin === initial.url.origin;
		const headers = headersForHop(init?.headers, sameOrigin);
		// `Host` must match the real hostname while we dial the vetted IP; TLS SNI
		// is set to the same name so certificate validation is unchanged.
		const pinnedHeaders = new Headers(headers ?? undefined);
		pinnedHeaders.set("Host", current.url.host);

		const response = await fetch(pinUrlToAddress(current.url, current.address), {
			...(init?.signal ? { signal: init.signal } : {}),
			headers: pinnedHeaders,
			redirect: "manual",
			tls: { serverName: current.url.hostname },
		});
		const location = response.headers.get("location");
		if (response.status >= 300 && response.status < 400 && location) {
			if (hop === MAX_REDIRECTS) throw new ValidationError("Too many download redirects", { code: "download.too_many_redirects" });

			current = await resolvePublicTarget(new URL(location, current.url).href);
			continue;
		}

		return response;
	}

	throw new ValidationError("Too many download redirects", { code: "download.too_many_redirects" });
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
