import { Elysia } from "elysia";
import { isImageAssetPath, isPluginUiPath } from "@/app/http/utils/route-classification.utils";
import { serverConfig } from "@/config/server/server.config";
import { getRequestClientIp } from "@/utils/client-ip.utils";
import { DomainError } from "@/utils/domain.errors";
import { getNormalizedPathname } from "@/utils/http.utils";
import { InMemoryRateLimiter } from "@/utils/in-memory.limiter";
import { isRecord } from "@/utils/type.utils";
import { tunedRouteMax } from "../../../config/rate-limit-overrides.utils";

const rateLimiter = new InMemoryRateLimiter();

interface RateLimitContext {
	user?: { id: string; role?: string } | null | undefined;
	profile?: { id: string } | null | undefined;
	server?: Parameters<typeof getRequestClientIp>[1] | undefined;
}

function setRateLimitHeaders(headers: unknown, limit: number, remaining: number, resetMs: number): void {
	const entries: Record<string, string> = {
		"X-RateLimit-Limit": String(limit),
		"X-RateLimit-Remaining": String(remaining),
		"X-RateLimit-Reset": String(Math.ceil(resetMs / 1000)),
	};
	if (headers instanceof Headers) {
		for (const [k, v] of Object.entries(entries)) headers.set(k, v);
	} else if (typeof headers === "object" && headers !== null) {
		Object.assign(headers, entries);
	}
}

function hasRateLimitHeaders(headers: unknown): boolean {
	if (headers instanceof Headers) return headers.has("X-RateLimit-Limit");

	return isRecord(headers) && "X-RateLimit-Limit" in headers;
}

function throwRateLimitExceeded(resetMs: number): never {
	throw new DomainError("too_many_requests", "Too many requests. Try again later.", {
		code: "rate_limit.exceeded",
		params: { retryAfterSeconds: Math.ceil(resetMs / 1000) },
	});
}

/** Forgets every counted request. Test suites that send many requests through one process call this between tests. */
export function clearRateLimitBuckets(): void {
	rateLimiter.clear();
}

function getClientIp(request: Request, server: RateLimitContext["server"]): string {
	return getRequestClientIp(request, server) ?? "unknown";
}

export function isExemptFromGlobalLimit(request: Request): boolean {
	if (request.method === "OPTIONS") return true;

	const pathname = getNormalizedPathname(request);
	if (pathname === "/v1/health" || pathname.startsWith("/v1/health/")) return true;

	if (isImageAssetPath(pathname)) return true;

	// Plugin UI bundles are loaded as ESM modules; throttling them breaks the UI.
	if (isPluginUiPath(pathname)) return true;

	// Only the playback HLS segment route is exempt. A broad
	// `pathname.includes("/segments/")` also exempted plugin-owned routes that
	// merely contained that word.
	if (pathname.startsWith("/v1/playback-sessions/") && pathname.includes("/segments/")) return true;

	// Page loads and SPA assets outside the API are cheap and precompressed —
	// a 429 here would render raw JSON instead of the app's own error screen.
	if ((request.method === "GET" || request.method === "HEAD") && !pathname.startsWith("/v1/")) return true;

	return false;
}

/** The user, profile and route params the request is acting on, read from the Elysia context. */
function readRequestSubject(context: object) {
	const user = "user" in context && isRecord(context.user) ? context.user : undefined;
	const profile = "profile" in context && isRecord(context.profile) ? context.profile : undefined;
	const params = "params" in context && isRecord(context.params) ? context.params : undefined;

	return {
		userId: user && typeof user.id === "string" ? user.id : undefined,
		userRole: user && typeof user.role === "string" ? user.role : undefined,
		profileId: profile && typeof profile.id === "string" ? profile.id : undefined,
		params,
	};
}

export const rateLimitMiddleware = new Elysia({ name: "RateLimitMiddleware" })
	.macro({
		rateLimit: (options: { name: string; max: number; windowMs: number; adminBypass?: boolean; perParam?: string }) => ({
			beforeHandle(context) {
				const { userId, userRole, profileId, params } = readRequestSubject(context);
				const { request, server, set } = context;

				if (options.adminBypass && userRole === "admin") return;

				const routeMax = tunedRouteMax(options.name, options.max) ?? Math.round(options.max * serverConfig.api.rateLimit.routeMultiplier);
				// Anonymous callers share one identity bucket per IP (never a global
				// "anonymous" bucket — five bad logins must not lock out the world).
				const identity = profileId ?? userId ?? `ip:${getClientIp(request, server)}`;
				// `perParam` gives every value of a route parameter (e.g. a plugin id) its own bucket,
				// so one chatty plugin cannot exhaust the budget of all the others.
				const scoped = options.perParam ? params?.[options.perParam] : undefined;
				const key = `${options.name}${typeof scoped === "string" ? `:${scoped}` : ""}:${identity}`;
				const result = rateLimiter.consume(key, routeMax, options.windowMs);
				// The route's budget is reported on every answer, so clients can pace themselves before a 429.
				setRateLimitHeaders(set.headers, routeMax, result.remaining, result.resetMs);
				if (!result.allowed) throwRateLimitExceeded(result.resetMs);
			},
		}),
	})
	.derive({ as: "global" }, ({ request, server, set }) => {
		if (isExemptFromGlobalLimit(request)) return {};

		const globalMax = serverConfig.api.rateLimit.globalMax;
		const globalWindowMs = serverConfig.api.rateLimit.globalWindowMs;
		const ip = getClientIp(request, server);
		const key = `global:${ip}`;
		const result = rateLimiter.consume(key, globalMax, globalWindowMs);

		if (!result.allowed) {
			setRateLimitHeaders(set.headers, globalMax, result.remaining, result.resetMs);
			throwRateLimitExceeded(result.resetMs);
		}

		return {
			rateLimitHeaders: result,
			rateLimitMax: globalMax,
		};
	})
	.onAfterHandle({ as: "global" }, ({ responseValue, set, rateLimitHeaders, rateLimitMax }) => {
		if (rateLimitHeaders) {
			const target = responseValue instanceof Response ? responseValue.headers : set.headers;
			// A route with its own budget already reported that budget in beforeHandle; the global one must not replace it.
			if (!(hasRateLimitHeaders(target) || hasRateLimitHeaders(set.headers))) {
				setRateLimitHeaders(target, rateLimitMax, rateLimitHeaders.remaining, rateLimitHeaders.resetMs);
			}
		}

		return responseValue;
	})
	.as("global");
