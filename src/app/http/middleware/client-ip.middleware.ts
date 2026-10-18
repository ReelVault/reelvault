import Elysia from "elysia";
import { CLIENT_IP_HEADER, resolveRequestClientIp } from "@/utils/client-ip.utils";

/**
 * Resolves the real client IP once per request and stamps it on the request
 * headers. `X-Forwarded-For` is honoured only up to `APP_TRUSTED_PROXY_COUNT`
 * hops, so a client cannot pick its own identity for rate limiting, audit
 * logs or Better Auth's login limiter by forging the header.
 */
export const clientIpMiddleware = new Elysia({ name: "ClientIpMiddleware" })
	.derive({ as: "global" }, ({ request, server }) => {
		request.headers.delete(CLIENT_IP_HEADER);
		const clientIp = resolveRequestClientIp(request, server);
		if (clientIp) request.headers.set(CLIENT_IP_HEADER, clientIp);

		return { clientIp };
	})
	.as("global");
