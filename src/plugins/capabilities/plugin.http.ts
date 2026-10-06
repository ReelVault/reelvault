import { isIP } from "node:net";
import { systemSettingsService } from "@/application/admin/system-settings.service";
import { ForbiddenError } from "@/utils/errors";
import { MemoryCache } from "@/utils/memory-cache";
import { normalizeLower } from "@/utils/type.utils";
import { guardedFetch, isPublicAddress } from "@/utils/url-guard.utils";

const MAX_REDIRECTS = 5;
const PLUGIN_HTTP_PROTOCOLS = ["http:", "https:"] as const;
const SETTING_ALLOWED_DOMAINS = "plugins.http.allowedDomains";

const LOCAL_HOST_SUFFIXES = [".local", ".localhost", ".internal", ".home.arpa"];

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

/**
 * Plugin-specific destination policy layered on top of the shared SSRF guard:
 * the optional `plugins.http.allowedDomains` allowlist plus local-host and
 * IP-literal rejection. DNS-resolved private addresses are rejected by the
 * shared guard itself.
 */
function assertPluginHostAllowed(hostname: string): void {
	const allowedList = systemSettingsService.get(SETTING_ALLOWED_DOMAINS);
	if (!isHostAllowed(hostname, allowedList)) {
		throw new ForbiddenError(`Destination host '${hostname}' is not on the plugins.http.allowedDomains allowlist`, {
			code: "plugin.http.host_not_allowed",
		});
	}

	if (hostname === "localhost" || LOCAL_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
		throw new ForbiddenError(`Plugin HTTP fetch to a local host is not allowed: ${hostname}`, { code: "plugin.http.private_address" });
	}

	if (isIP(hostname) !== 0 && !isPublicAddress(hostname)) {
		throw new ForbiddenError(`Plugin HTTP fetch to a private address is not allowed: ${hostname}`, { code: "plugin.http.private_address" });
	}
}

function inputToUrl(input: RequestInfo | URL): string {
	if (typeof input === "string") return input;

	if (input instanceof URL) return input.href;

	return input.url;
}

/**
 * Drop-in `fetch` replacement handed to providers and the `httpFetch` plugin
 * capability. Same signature as `fetch`, but every hop is SSRF-guarded:
 * http(s)-only, allowlist/local-host policy, and pinned to a vetted public IP.
 */
export function guardedPluginFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	return guardedFetch(inputToUrl(input), {
		...init,
		allowedProtocols: PLUGIN_HTTP_PROTOCOLS,
		maxRedirects: MAX_REDIRECTS,
		assertHostAllowed: assertPluginHostAllowed,
		dnsCache,
	});
}
