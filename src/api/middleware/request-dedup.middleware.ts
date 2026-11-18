import { hash as bunHash } from "bun";
import { Elysia } from "elysia";
import { env } from "@/config/env.config";
import { serverConfig } from "@/config/server/server.config";
import { getResponseStatus, requestIdentityKey } from "@/utils/http.utils";
import { serializedBodyCache } from "./serialized-body.cache";

// Benchmark honesty escape hatch: with dedup disabled every request does its
// own work instead of joining an identical in-flight response.
const dedupDisabledByEnv = env.REELVAULT_BENCH_DISABLE_DEDUP === "true";

interface DedupWaiter {
	resolve: (response: Response) => void;
	reject: (reason?: unknown) => void;
}

interface InflightEntry {
	readonly key: string;
	/** Set by the leader once the handler produced a value (or threw). */
	settled: boolean;
	/** When the leader registered; a leader that never settles is swept after a few wait windows. */
	createdAt: number;
	responseValue?: unknown;
	status: number;
	error?: unknown;
	/** Memoized shared Response — built once, on the first follower claim. */
	response?: Response | undefined;
	waiters: DedupWaiter[];
}

const inflight = new Map<string, InflightEntry>();
/** Which entry (if any) each request created as leader — identity survives key reuse. */
const leaderEntries = new WeakMap<object, InflightEntry>();
let trackedCount = 0;

/** Release a leader's slot and pass its failure to every waiter. */
function failEntry(entry: InflightEntry, error: unknown): void {
	inflight.delete(entry.key);
	trackedCount--;
	const waiters = entry.waiters;
	entry.waiters = [];
	entry.settled = true;
	entry.error = error;
	for (const waiter of waiters) waiter.reject(error);
}

/**
 * A leader whose request was aborted without running `mapResponse`/`onError`
 * would otherwise stay in `inflight` forever and permanently consume a slot.
 * Sweeping only when the cap is reached keeps the common path allocation-free.
 */
function evictEntry(entry: InflightEntry): void {
	failEntry(entry, new Error("Dedup leader expired"));
}

/** A leader older than two wait windows is abandoned: its key stops blocking new requests. */
function isStale(entry: InflightEntry, now: number): boolean {
	return entry.settled || now - entry.createdAt > serverConfig.requestDedup.waitTimeoutMs * 2;
}

function sweepStaleEntries(): void {
	const now = Date.now();
	for (const entry of inflight.values()) {
		if (!isStale(entry, now)) continue;

		evictEntry(entry);
	}
}

/** Undefined means the leader disappeared: the caller must run its own handler. */
async function waitForLeader(entry: InflightEntry): Promise<Response | undefined> {
	try {
		const response = await new Promise<Response>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("Dedup wait timeout")), serverConfig.requestDedup.waitTimeoutMs);
			timer.unref();
			if (entry.settled) {
				clearTimeout(timer);
				if (entry.error === undefined) {
					resolve(buildSharedResponse(entry));
				} else {
					reject(entry.error);
				}

				return;
			}

			entry.waiters.push({
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
 * Key = method + pathname + search + credential (authorization header, session
 * cookie, profile header, API key).
 * Only applies to GET/HEAD requests.
 * Followers clone a shared Response that is materialized lazily — a leader with
 * zero followers never stringifies the body a second time.
 */
export const requestDedupMiddleware = new Elysia({ name: "RequestDedup" })
	.macro({
		deduplicate: (_options: { enabled?: boolean } = {}) => ({
			async beforeHandle(context: { request: Request }): Promise<Response | undefined> {
				if (_options.enabled === false || dedupDisabledByEnv || !serverConfig.requestDedup.enabled) return undefined;

				if (!(context.request.method === "GET" || context.request.method === "HEAD")) return undefined;

				if (trackedCount >= serverConfig.requestDedup.maxConcurrent) {
					sweepStaleEntries();
					if (trackedCount >= serverConfig.requestDedup.maxConcurrent) return undefined;
				}

				// GET and HEAD share a route but not a response contract — keep them apart.
				const composed = requestIdentityKey(context.request, { includeMethod: true });
				// Raw keys win the A/B benchmark at realistic lengths and make
				// collisions impossible; oversized keys hash instead so a bounded
				// in-flight map can't be amplified into a memory sink.
				const key = composed.length > serverConfig.requestDedup.rawKeyMaxLength ? bunHash(composed).toString(16) : composed;

				const existing = inflight.get(key);
				// Followers must not depend on the leader's cleanup running: cap the
				// wait and execute normally when the leader disappears (or is stuck).
				if (existing && !isStale(existing, Date.now())) return await waitForLeader(existing);

				if (existing) evictEntry(existing);
				const entry: InflightEntry = { key, settled: false, createdAt: Date.now(), status: 200, waiters: [] };
				inflight.set(key, entry);
				trackedCount++;
				leaderEntries.set(context, entry);

				return undefined;
			},
		}),
	})
	.mapResponse({ as: "global" }, (context) => {
		// Identity, not just the key: a leader whose entry was evicted while it was
		// still running must never resolve the *next* leader's entry.
		const { responseValue, set } = context;
		const entry = leaderEntries.get(context);
		if (!entry || inflight.get(entry.key) !== entry) return;

		inflight.delete(entry.key);
		trackedCount--;
		entry.responseValue = responseValue;
		entry.status = getResponseStatus(set);
		settleEntry(entry);
	})
	.onError({ as: "global" }, (context) => {
		const entry = leaderEntries.get(context);
		if (!entry || inflight.get(entry.key) !== entry) return;

		failEntry(entry, context.error);
	})
	.as("global");
