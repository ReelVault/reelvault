import { env } from "@/config/env.config";
import { parseOriginUrl } from "@/utils/http.utils";
import { isLoopbackHost, isOriginAllowed } from "@/utils/origin-trust.utils";

const RAW_IPV4_PATTERN = /^(\d{1,3}\.){3}\d{1,3}$/;
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
	if (isLoopbackHost(hostname)) {
		return undefined;
	}

	// Raw IPv4 address — same logic (port-independent, no domain attr needed)
	if (RAW_IPV4_PATTERN.test(hostname)) return undefined;

	// Named domain (rv.lan, rv.domena.pl, …) — scope to parent domain
	return `.${hostname}`;
}
