import { isIP } from "node:net";
import { serverConfig } from "@/server.config";
import { trimAndFilter } from "@/utils/array.utils";

/**
 * Request header carrying the client IP resolved by `clientIpMiddleware`.
 * Any incoming value is discarded before the trusted one is stamped, so every
 * consumer that only sees `Headers` (rate limiter, admin audit, Better Auth's
 * limiter) can read it without re-deriving trust.
 */
export const CLIENT_IP_HEADER = "x-reelvault-client-ip";

const IPV4_MAPPED_PREFIX = "::ffff:";

export interface ResolveClientIpInput {
	/** TCP peer address of the connection (Bun `server.requestIP`). */
	remoteAddress: string | null | undefined;
	/** Raw `X-Forwarded-For` header value. */
	forwardedFor: string | null | undefined;
	/** Number of proxies in front of the server trusted to append `X-Forwarded-For`. */
	trustedProxyCount: number;
}

interface RequestIpSource {
	requestIP(request: Request): { address: string } | null;
}

/**
 * Normalizes a raw address to a bare IP string: strips brackets, unwraps
 * IPv4-mapped IPv6 (`::ffff:10.0.0.1` — what Bun reports on dual-stack
 * sockets) and rejects anything that is not a valid IP.
 */
export function normalizeIp(value: string | null | undefined): string | null {
	if (!value) return null;

	let ip = value.trim();
	if (ip.startsWith("[") && ip.endsWith("]")) ip = ip.slice(1, -1);

	if (ip.toLowerCase().startsWith(IPV4_MAPPED_PREFIX)) {
		const mapped = ip.slice(IPV4_MAPPED_PREFIX.length);
		if (isIP(mapped) === 4) ip = mapped;
	}

	return isIP(ip) ? ip : null;
}

/**
 * Resolves the real client IP from the socket peer and the trusted tail of
 * `X-Forwarded-For`.
 *
 * With `trustedProxyCount = N` the peer is proxy N and the last N-1 hops of
 * the header are the remaining proxies; the hop just before them is the
 * client as attested by the first trusted proxy. Everything further left was
 * written by the client itself and is never used. A chain shorter than the
 * configured proxy count means the request bypassed a proxy, so the peer
 * address is returned instead of a client-chosen value.
 */
export function resolveClientIp({ remoteAddress, forwardedFor, trustedProxyCount }: ResolveClientIpInput): string | null {
	const peer = normalizeIp(remoteAddress);
	if (trustedProxyCount <= 0 || !forwardedFor) return peer;

	const hops = trimAndFilter(forwardedFor.split(","));
	const clientIndex = hops.length - trustedProxyCount;
	if (clientIndex < 0) return peer;

	return normalizeIp(hops[clientIndex]) ?? peer;
}

/** Resolves the client IP of a live request using the configured proxy trust. */
export function resolveRequestClientIp(request: Request, server: RequestIpSource | null | undefined): string | null {
	return resolveClientIp({
		remoteAddress: server?.requestIP(request)?.address,
		forwardedFor: request.headers.get("x-forwarded-for"),
		trustedProxyCount: serverConfig.network.trustedProxyCount,
	});
}

/**
 * Reads the IP stamped by `clientIpMiddleware`, resolving it directly when the
 * middleware has not run for this request (isolated tests, ad-hoc apps).
 */
export function getRequestClientIp(request: Request, server: RequestIpSource | null | undefined): string | null {
	return request.headers.get(CLIENT_IP_HEADER) ?? resolveRequestClientIp(request, server);
}
