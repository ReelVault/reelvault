import { Elysia } from "elysia";
import { isImageAssetPath, isPluginUiPath } from "@/api/utils/route-classification.utils";
import { serverConfig } from "@/server.config";
import { getRequestClientIp } from "@/utils/client-ip.utils";
import { TooManyRequestsError } from "@/utils/errors";
import { getPathname } from "@/utils/http.utils";
import { isRecord } from "@/utils/type.utils";

export class InMemoryRateLimiter {
	private readonly buckets = new Map<string, { startedAt: number; lastAccess: number; count: number; windowMs: number }>();

	constructor() {
		setInterval(() => this.sweep(Date.now()), serverConfig.api.rateLimit.cleanupWindowMs).unref();
	}

	consume(key: string, max: number, windowMs: number, now = Date.now()): { allowed: boolean; remaining: number; resetMs: number } {
		const current = this.buckets.get(key);
		if (!current || now - current.startedAt >= windowMs) {
			if (current) this.buckets.delete(key);

			if (this.buckets.size >= serverConfig.api.rateLimit.maxBuckets) {
				this.evictOldest();
			}

			this.buckets.set(key, { startedAt: now, lastAccess: now, count: 1, windowMs });

			return { allowed: true, remaining: max - 1, resetMs: windowMs };
		}

		// Re-insert to keep LRU order (most recently accessed at the tail).
		this.buckets.delete(key);
		current.lastAccess = now;

		if (current.count >= max) {
			this.buckets.set(key, current);
			const resetMs = windowMs - (now - current.startedAt);

			return { allowed: false, remaining: 0, resetMs };
		}

		current.count += 1;
		this.buckets.set(key, current);

		return { allowed: true, remaining: max - current.count, resetMs: windowMs - (now - current.startedAt) };
	}

	has(key: string): boolean {
		return this.buckets.has(key);
	}

	clear(): void {
		this.buckets.clear();
	}

	evictOldest(): void {
		const oldestKey = this.buckets.keys().next().value;
		if (oldestKey !== undefined) this.buckets.delete(oldestKey);
	}

	sweep(now: number): void {
		// Expire against each bucket's OWN window — the sweep interval
		// (cleanupWindowMs) can be shorter than a route's window, and deleting a
		// live bucket would silently reset its counter.
		for (const [key, bucket] of this.buckets) {
			if (now - bucket.startedAt >= bucket.windowMs) this.buckets.delete(key);
		}
	}
}

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

function throwRateLimitExceeded(resetMs: number): never {
	throw new TooManyRequestsError("Too many requests. Try again later.", {
		code: "rate_limit.exceeded",
		params: { retryAfterSeconds: Math.ceil(resetMs / 1000) },
	});
}

function getClientIp(request: Request, server: RateLimitContext["server"]): string {
	return getRequestClientIp(request, server) ?? "unknown";
}

export function isExemptFromGlobalLimit(request: Request): boolean {
	if (request.method === "OPTIONS") return true;

	const pathname = getPathname(request.url);
	if (pathname === "/v1/health" || pathname.startsWith("/v1/health/")) return true;

	if (isImageAssetPath(request.url)) return true;

	// Plugin UI bundles are loaded as ESM modules; throttling them breaks the UI.
	if (isPluginUiPath(request.url)) return true;

	// Only the playback HLS segment route is exempt. A broad
	// `pathname.includes("/segments/")` also exempted plugin-owned routes that
	// merely contained that word.
	return pathname.startsWith("/v1/playback-sessions/") && pathname.includes("/segments/");
}

export const rateLimitMiddleware = new Elysia({ name: "RateLimitMiddleware" })
	.macro({
		rateLimit: (options: { name: string; max: number; windowMs: number; adminBypass?: boolean }) => ({
			beforeHandle(context) {
				const user = "user" in context && isRecord(context.user) ? context.user : undefined;
				const userId = user && typeof user.id === "string" ? user.id : undefined;
				const userRole = user && typeof user.role === "string" ? user.role : undefined;

				const profile = "profile" in context && isRecord(context.profile) ? context.profile : undefined;
				const profileId = profile && typeof profile.id === "string" ? profile.id : undefined;

				const { request, server, set } = context;

				if (options.adminBypass && userRole === "admin") return;

				const routeMax = Math.round(options.max * serverConfig.api.rateLimit.routeMultiplier);
				// Anonymous callers share one identity bucket per IP (never a global
				// "anonymous" bucket — five bad logins must not lock out the world).
				const identity = profileId ?? userId ?? `ip:${getClientIp(request, server)}`;
				const key = `${options.name}:${identity}`;
				const result = rateLimiter.consume(key, routeMax, options.windowMs);
				if (!result.allowed) {
					setRateLimitHeaders(set.headers, routeMax, result.remaining, result.resetMs);
					throwRateLimitExceeded(result.resetMs);
				}
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
			setRateLimitHeaders(target, rateLimitMax, rateLimitHeaders.remaining, rateLimitHeaders.resetMs);
		}

		return responseValue;
	})
	.as("global");
