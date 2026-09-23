import { lookup } from "node:dns/promises";
import { systemSettingsService } from "@/application/admin/system-settings.service";
import { ForbiddenError, ValidationError } from "@/utils/errors";
import { MemoryCache } from "@/utils/memory-cache";
import { normalizeLower } from "@/utils/type.utils";
import { isPublicAddress, pinUrlToAddress } from "@/utils/url-guard.utils";

const MAX_REDIRECTS = 5;
const SETTING_ALLOWED_DOMAINS = "plugins.http.allowedDomains";

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const LOCAL_HOST_SUFFIXES = [".local", ".localhost", ".internal", ".home.arpa"];
const BRACKET_WRAP = /^\[|\]$/;

/** Resolved-address cache bounds DNS lookups while still defeating rebinding within the TTL. */
const dnsCache = new MemoryCache<string[]>({ ttlMs: 60_000, maxSize: 200, name: "plugin-http-dns" });

/**
 * Pure domain check (unit-tested): `allowed` is a comma-separated list; empty
 * list = every public host allowed. A list entry also covers its subdomains.
 */
export function isHostAllowed(hostname: string, allowedList: string): boolean {
	const allowed = allowedList
		.split(",")
		.map((entry) => normalizeLower(entry))
		.filter(Boolean);
	if (allowed.length === 0) return true;

	const host = normalizeLower(hostname);

	return allowed.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

async function resolveHost(host: string): Promise<string[]> {
	const cached = dnsCache.get(host);
	if (cached) return cached;

	const results = await lookup(host, { all: true });
	const addresses = results.map((result) => result.address);
	dnsCache.set(host, addresses);

	return addresses;
}

/**
 * SSRF guard: rejects non-HTTP(S) schemes, hosts outside the optional
 * `plugins.http.allowedDomains` allowlist, and any host that resolves to a
 * non-public address (loopback/RFC1918/link-local/ULA/…). Applied to the
 * initial request and to every redirect hop.
 */
export async function assertDestinationAllowed(rawUrl: string): Promise<string> {
	const parsed = new URL(rawUrl);
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new ValidationError(`Unsupported protocol for plugin HTTP fetch: ${parsed.protocol}`, { code: "plugin.http.invalid_protocol" });
	}

	const allowedList = systemSettingsService.get(SETTING_ALLOWED_DOMAINS);
	if (!isHostAllowed(parsed.hostname, allowedList)) {
		throw new ForbiddenError(`Destination host '${parsed.hostname}' is not on the plugins.http.allowedDomains allowlist`, {
			code: "plugin.http.host_not_allowed",
		});
	}

	const host = parsed.hostname.toLowerCase().replace(BRACKET_WRAP, "");
	if (host === "localhost" || LOCAL_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
		throw new ForbiddenError(`Plugin HTTP fetch to a local host is not allowed: ${host}`, { code: "plugin.http.private_address" });
	}

	if (!isPublicAddress(host)) {
		throw new ForbiddenError(`Plugin HTTP fetch to a private address is not allowed: ${host}`, { code: "plugin.http.private_address" });
	}

	const addresses = await resolveHost(host);
	if (addresses.length === 0 || addresses.some((address) => !isPublicAddress(address))) {
		throw new ForbiddenError(`Plugin HTTP fetch to a host resolving to a private address is not allowed: ${host}`, {
			code: "plugin.http.private_address",
		});
	}

	// Return the vetted address so the caller can pin the connection and close the
	// DNS-rebinding window between this check and fetch()'s own resolution.
	const chosen = addresses.find((address) => !address.includes(":")) ?? addresses[0];
	if (!chosen) {
		throw new ForbiddenError(`Plugin HTTP fetch to a host resolving to a private address is not allowed: ${host}`, {
			code: "plugin.http.private_address",
		});
	}

	return chosen;
}

function inputToUrl(input: RequestInfo | URL): string {
	if (typeof input === "string") return input;

	if (input instanceof URL) return input.href;

	return input.url;
}

async function fetchFollowingRedirects(url: string, init?: RequestInit): Promise<Response> {
	let currentUrl = url;
	let currentInit = init;
	const initialOrigin = new URL(url).origin;

	for (let redirects = 0; ; redirects++) {
		const address = await assertDestinationAllowed(currentUrl);

		const parsed = new URL(currentUrl);
		const headers = headersForHop(currentInit?.headers, parsed.origin === initialOrigin);
		// Dial the vetted IP but keep the real Host/SNI so virtual hosting and TLS
		// certificate validation are unchanged — no second DNS lookup to rebind.
		const pinnedHeaders = new Headers(headers ?? undefined);
		pinnedHeaders.set("Host", parsed.host);

		const response = await fetch(pinUrlToAddress(parsed, address), {
			...currentInit,
			headers: pinnedHeaders,
			redirect: "manual",
			tls: { serverName: parsed.hostname },
		});
		if (!REDIRECT_STATUS.has(response.status)) return response;

		const location = response.headers.get("location");
		if (!location) return response;

		if (redirects >= MAX_REDIRECTS)
			throw new ValidationError("Plugin HTTP fetch exceeded the redirect limit", { code: "plugin.http.redirect_limit" });

		// Match the fetch spec: 303 (and 301/302 for non-GET/HEAD) downgrade to GET.
		const method = (currentInit?.method ?? "GET").toUpperCase();
		if (response.status === 303 || ((response.status === 301 || response.status === 302) && method !== "GET" && method !== "HEAD")) {
			currentInit = { ...currentInit, method: "GET", body: null };
		}

		currentUrl = new URL(location, currentUrl).href;
	}
}

/** Headers that must never be replayed to a different origin on redirect. */
const CROSS_ORIGIN_STRIPPED_HEADERS = ["authorization", "cookie", "proxy-authorization", "x-api-key", "x-auth-token", "x-goog-api-key"];

function headersForHop(headers: HeadersInit | undefined, sameOrigin: boolean): HeadersInit | undefined {
	if (sameOrigin) return headers;

	const merged = new Headers(headers);
	for (const name of CROSS_ORIGIN_STRIPPED_HEADERS) merged.delete(name);

	return merged;
}

/**
 * Drop-in `fetch` replacement handed to providers and the `httpFetch` plugin
 * capability. Same signature as `fetch`, but every hop is SSRF-guarded.
 */
export function guardedPluginFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	return fetchFollowingRedirects(inputToUrl(input), init);
}
