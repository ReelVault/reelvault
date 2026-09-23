import {
	fmtMs,
	type HttpScenarioResult,
	type HttpScenarioRun,
	httpScenarioResult,
	main,
	printHttpResults,
	printTable,
	runHttpScenario,
	suiteArgs,
	summarizeLatencies,
	task,
} from "benchkit";
import { isRecord } from "@/utils/type.utils";
import { subnetIp } from "./lib/identity";
import type { ManagedServer } from "./lib/server";
import { createServerFixture } from "./lib/server-fixture";

/**
 * Mutation/write endpoint suite — the least-measured shared path before this
 * existed: every write hits SQLite WAL, FTS triggers and response-body cache
 * invalidation (invalidateProfileResponseBodies scans both caches per key).
 * Writes are per-profile, so each worker keeps one identity for the whole run
 * (unlike http.ts, which rotates identities per request).
 */

interface WriteContext {
	baseUrl: string;
	/** One cookie+profile per worker — writes land on distinct profiles. */
	cookieFor: (workerIndex: number) => string;
	profileIdFor: (workerIndex: number) => string;
	mediaFileId: string;
	/** Preloaded notification ids per worker identity (user-scoped rows). */
	notificationIds: string[][];
}

type WriteRequestBuilder = (context: WriteContext, workerIndex: number, requestIndex: number) => Request;

function writeHeaders(context: WriteContext, workerIndex: number): Record<string, string> {
	return {
		cookie: context.cookieFor(workerIndex),
		"x-profile-id": context.profileIdFor(workerIndex),
		"x-forwarded-for": subnetIp(80, workerIndex),
	};
}

function jsonRequest(url: string, method: "POST" | "PUT" | "PATCH" | "DELETE", headers: Record<string, string>, body?: unknown): Request {
	return new Request(url, {
		method,
		headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}

const playbackProgressUpsert: WriteRequestBuilder = (context, workerIndex, requestIndex) =>
	jsonRequest(
		`${context.baseUrl}/v1/me/media-files/${context.mediaFileId}/playback-progress`,
		"PUT",
		writeHeaders(context, workerIndex),
		// Same media file, moving position — mirrors the per-heartbeat upsert on a hot row.
		{ position: requestIndex % 600 },
	);

const metadataIdFor = (workerIndex: number, requestIndex: number): string =>
	// Per-worker id space — two workers toggling the same watchlist row would
	// collide on unique constraints and pollute the error rate.
	`meta-${String((workerIndex * 250 + (requestIndex >> 1)) % 5000).padStart(7, "0")}`;

const watchlistAddRemove: WriteRequestBuilder = (context, workerIndex, requestIndex) => {
	const headers = writeHeaders(context, workerIndex);
	// Pairs: even request adds an id, odd request removes it — the list never
	// grows without bound and every pair pays the full add+invalidate+delete path.
	const metadataId = metadataIdFor(workerIndex, requestIndex >> 1);

	return requestIndex % 2 === 0
		? jsonRequest(`${context.baseUrl}/v1/me/watchlist`, "POST", headers, { metadataId })
		: jsonRequest(`${context.baseUrl}/v1/me/watchlist/${metadataId}`, "DELETE", headers);
};

const ratingAddRemove: WriteRequestBuilder = (context, workerIndex, requestIndex) => {
	const headers = writeHeaders(context, workerIndex);
	const metadataId = metadataIdFor(workerIndex, requestIndex >> 1);

	return requestIndex % 2 === 0
		? jsonRequest(`${context.baseUrl}/v1/me/ratings`, "POST", headers, { metadataId, rating: (requestIndex % 4) * 0.5 })
		: jsonRequest(`${context.baseUrl}/v1/me/ratings/${metadataId}`, "DELETE", headers);
};

const watchedHistorySync: WriteRequestBuilder = (context, workerIndex, requestIndex) =>
	jsonRequest(`${context.baseUrl}/v1/me/watched-history`, "POST", writeHeaders(context, workerIndex), {
		mediaFileId: context.mediaFileId,
		durationWatched: 300 + (requestIndex % 1200),
		isFullWatch: requestIndex % 5 === 0,
	});

interface WriteScenarioDefinition {
	name: string;
	builder: WriteRequestBuilder;
}

const SCENARIOS: readonly WriteScenarioDefinition[] = [
	{ name: "PUT /v1/me/media-files/:id/playback-progress (upsert)", builder: playbackProgressUpsert },
	{ name: "POST+DELETE /v1/me/watchlist (toggle pair)", builder: watchlistAddRemove },
	{ name: "POST+DELETE /v1/me/ratings (toggle pair)", builder: ratingAddRemove },
	{ name: "POST /v1/me/watched-history (sync)", builder: watchedHistorySync },
];

function runScenario(
	scenario: WriteScenarioDefinition,
	concurrency: number,
	context: WriteContext,
	warmupMs: number,
	durationMs: number,
): Promise<HttpScenarioRun> {
	return runHttpScenario({
		concurrency,
		warmupMs,
		durationMs,
		work: async (workerIndex, requestIndex) => {
			try {
				const response = await fetch(scenario.builder(context, workerIndex, requestIndex));
				const ok = response.ok;
				await response.arrayBuffer();

				return { ok };
			} catch {
				return { ok: false };
			}
		},
	});
}

async function preloadNotificationIds(server: ManagedServer, workerIndex: number): Promise<string[]> {
	// Seeded notifications belong to the per-worker identities, not the admin —
	// list them as their owner. Only unread ones: re-marking a read row is 403.
	const response = await fetch(`${server.baseUrl}/v1/notifications?unreadOnly=true&limit=50`, {
		headers: {
			cookie: server.workerCookies[workerIndex] ?? server.cookie,
			"x-profile-id": server.profileIdFor(workerIndex),
			"x-forwarded-for": "10.80.0.1",
		},
	});
	if (!response.ok) return [];

	const payload: unknown = await response.json();
	if (!Array.isArray(payload)) return [];

	return payload.flatMap((item) => (isRecord(item) && typeof item.id === "string" ? [item.id] : []));
}

/**
 * Mark-read phase — a notification flips read exactly once (re-marking an
 * already-read id is a 403), so this cannot be a sustained write loop. Instead
 * each worker marks its own seeded notifications once, like a client opening
 * the notifications page; the measured value is the latency distribution of
 * that one-shot burst.
 */
async function runNotificationMarkReadPhase(context: WriteContext, workerCount: number): Promise<void> {
	const latencies: number[] = [];
	let failures = 0;

	const worker = async (workerIndex: number): Promise<void> => {
		const headers = {
			"content-type": "application/json",
			cookie: context.cookieFor(workerIndex),
			"x-profile-id": context.profileIdFor(workerIndex),
			"x-forwarded-for": `10.80.1.${(workerIndex % 250) + 1}`,
		};
		for (const notificationId of context.notificationIds[workerIndex] ?? []) {
			const requestStartedAt = performance.now();
			try {
				const response = await fetch(`${context.baseUrl}/v1/notifications/${notificationId}`, {
					method: "PATCH",
					headers,
					body: "{}",
				});
				await response.arrayBuffer();
				if (!response.ok) failures++;
			} catch {
				failures++;
			}

			latencies.push(performance.now() - requestStartedAt);
		}
	};

	await Promise.all(Array.from({ length: workerCount }, (_, workerIndex) => worker(workerIndex)));

	const stats = summarizeLatencies(latencies.length > 0 ? latencies : [0]);
	printTable(
		`PATCH /v1/notifications/:id mark-read burst (${workerCount} identities)`,
		["marks", "p50", "p95", "p99", "failures"],
		[[String(stats.count), fmtMs(stats.p50Ms), fmtMs(stats.p95Ms), fmtMs(stats.p99Ms), String(failures)]],
	);
}

export const meta = { description: "Mutation/write endpoints (playback-progress upsert, watchlist, ratings, history sync, mark-read)" };

const args = suiteArgs();

if (!args.help) {
	const serverFixture = createServerFixture({
		seedRows: args.rows,
		workerCount: Math.max(...args.concurrency),
		keepServer: args.keepServer,
	});

	task("write: endpoints", async () => {
		let server: ManagedServer | undefined;
		try {
			server = await serverFixture();

			const managed = server;
			const workerCount = managed.workerCookies.length;
			const notificationIds = await Promise.all(
				Array.from({ length: workerCount }, (_, workerIndex) => preloadNotificationIds(managed, workerIndex)),
			);
			console.log(`[write] server ready, ${workerCount} identities, ${notificationIds.flat().length} notification ids`);

			const context: WriteContext = {
				baseUrl: server.baseUrl,
				cookieFor: (workerIndex) => server?.workerCookies[workerIndex % server.workerCookies.length] ?? server?.cookie ?? "",
				profileIdFor: (workerIndex) => server?.profileIdFor(workerIndex) ?? `profile-bench-${workerIndex}`,
				mediaFileId: server.benchmarkMediaFileId,
				notificationIds,
			};

			const results: HttpScenarioResult[] = [];
			for (const concurrency of args.concurrency) {
				console.log(`\n[write] concurrency ${concurrency} (warmup ${args.warmupMs}ms, measure ${args.durationMs}ms)`);
				for (const scenario of SCENARIOS) {
					const run = await runScenario(scenario, concurrency, context, args.warmupMs, args.durationMs);
					const result = httpScenarioResult(scenario.name, concurrency, run, args.durationMs);
					results.push(result);
					const failureNote = result.errorRatePercent > 0 ? `, errors ${result.errorRatePercent.toFixed(1)}%` : "";
					console.log(
						`  ${scenario.name}: ${result.requestsPerSecond.toFixed(0)} writes/s, p95 ${result.stats.p95Ms.toFixed(1)}ms${failureNote}`,
					);
				}
			}

			printHttpResults(results);

			await runNotificationMarkReadPhase(context, workerCount);
		} finally {
			if (!args.keepServer) {
				await server?.stop();
			}
		}
	});
}

await main(import.meta);
