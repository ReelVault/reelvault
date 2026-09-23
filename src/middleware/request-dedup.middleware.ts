import { hash as bunHash } from "bun";
import { Elysia } from "elysia";
import { serverConfig } from "@/server.config";
import { getResponseStatus } from "@/utils/http.utils";
import { serializedBodyCache } from "./response-cache.middleware";

interface DedupContext {
	_dedupKey?: string | undefined;
}

interface DedupWaiter {
	resolve: (response: Response) => void;
	reject: (reason?: unknown) => void;
}

interface InflightEntry {
	/** Set by the leader once the handler produced a value (or threw). */
	settled: boolean;
	responseValue?: unknown;
	status: number;
	error?: unknown;
	/** Memoized shared Response — built once, on the first follower claim. */
	response?: Response | undefined;
	waiters: DedupWaiter[];
}

const inflight = new Map<string, InflightEntry>();
let trackedCount = 0;

function buildSharedResponse(entry: InflightEntry): Response {
	if (entry.response) return entry.response;

	const value = entry.responseValue;
	if (value instanceof Response) {
		entry.response = value;
	} else if (typeof value === "string") {
		entry.response = new Response(value, {
			status: entry.status,
			headers: { "content-type": "text/plain; charset=utf-8" },
		});
	} else {
		// Reuse the serialization shared with response-cache/compression so the
		// body is stringified at most once per request across all three.
		const cachedBody = value !== null && typeof value === "object" ? serializedBodyCache.get(value) : undefined;
		const body = cachedBody ?? JSON.stringify(value);
		entry.response = new Response(body, {
			status: entry.status,
			headers: { "content-type": "application/json" },
		});
	}

	return entry.response;
}

function settleEntry(entry: InflightEntry): void {
	entry.settled = true;
	if (entry.waiters.length === 0) return;

	const response = buildSharedResponse(entry);
	const waiters = entry.waiters;
	entry.waiters = [];
	for (const waiter of waiters) {
		waiter.resolve(response);
	}
}

/**
 * Request Deduplication Middleware.
 * Shares in-flight GET/HEAD responses between concurrent requests with the same key.
 *
 * Usage (macro, opt-in per route):
 *   .get("/catalog", handler, { deduplicate: {} })
 *
 * Key = pathname + search + authorization header.
 * Only applies to GET/HEAD requests.
 * Followers clone a shared Response that is materialized lazily — a leader with
 * zero followers never stringifies the body a second time.
 */
export const requestDedupMiddleware = new Elysia({ name: "RequestDedup" })
	.macro({
		deduplicate: (_options: { enabled?: boolean } = {}) => ({
			async beforeHandle(context: { request: Request } & DedupContext): Promise<Response | undefined> {
				if (_options.enabled === false || !serverConfig.requestDedup.enabled) return undefined;

				if (!(context.request.method === "GET" || context.request.method === "HEAD")) return undefined;

				if (trackedCount >= serverConfig.requestDedup.maxConcurrent) return undefined;

				const rawUrl = context.request.url;
				// Pathname + search without a URL allocation (slice-based parser).
				const pathStart = rawUrl.indexOf("/", rawUrl.indexOf("//") + 2);
				const pathWithQuery = pathStart === -1 ? rawUrl : rawUrl.slice(pathStart);
				const auth = context.request.headers.get("authorization") ?? "";
				const cookie = context.request.headers.get("cookie") ?? "";
				// The active profile may arrive via this header (instead of the profile cookie)
				// — without it, two profiles of the same user would share deduplicated
				// responses that contain per-profile state.
				const profileId = context.request.headers.get("x-profile-id") ?? "";
				const composed = `${pathWithQuery}:${auth}:${cookie}:${profileId}`;
				// Raw keys win the A/B benchmark at realistic lengths and make
				// collisions impossible; oversized keys hash instead so a bounded
				// in-flight map can't be amplified into a memory sink.
				const key = composed.length > serverConfig.requestDedup.rawKeyMaxLength ? bunHash(composed).toString(16) : composed;

				const existing = inflight.get(key);
				if (existing) {
					// Followers must not depend on the leader's cleanup running: cap the
					// wait and execute normally when the leader disappears (or is stuck).
					try {
						const response = await new Promise<Response>((resolve, reject) => {
							const timer = setTimeout(() => reject(new Error("Dedup wait timeout")), serverConfig.requestDedup.waitTimeoutMs);
							timer.unref();
							if (existing.settled) {
								clearTimeout(timer);
								if (existing.error !== undefined) {
									reject(existing.error);
								} else {
									resolve(buildSharedResponse(existing));
								}

								return;
							}

							existing.waiters.push({
								resolve: (resolved) => {
									clearTimeout(timer);
									resolve(resolved);
								},
								reject: (failed) => {
									clearTimeout(timer);
									reject(failed);
								},
							});
						});

						return response.clone();
					} catch {
						return undefined;
					}
				}

				inflight.set(key, { settled: false, status: 200, waiters: [] });
				trackedCount++;
				context._dedupKey = key;

				return undefined;
			},
		}),
	})
	.mapResponse({ as: "global" }, (context) => {
		// Only the registered leader may clean up the entry. Fallback key derivation
		// here would let a follower delete/resolve a *new* leader's entry (race) and
		// inflate trackedCount, permanently disabling deduplication.
		const { responseValue, set } = context;
		const key = "_dedupKey" in context && typeof context._dedupKey === "string" ? context._dedupKey : undefined;
		if (!key) return;

		const entry = inflight.get(key);
		if (entry) {
			inflight.delete(key);
			trackedCount--;
			entry.responseValue = responseValue;
			entry.status = getResponseStatus(set);
			settleEntry(entry);
		}
	})
	.onError({ as: "global" }, (context) => {
		const key = "_dedupKey" in context && typeof context._dedupKey === "string" ? context._dedupKey : undefined;
		if (!key) return;

		const entry = inflight.get(key);
		if (entry) {
			inflight.delete(key);
			trackedCount--;
			entry.error = context.error;
			const waiters = entry.waiters;
			entry.waiters = [];
			entry.settled = true;
			for (const waiter of waiters) {
				waiter.reject(context.error);
			}
		}
	})
	.as("global");
