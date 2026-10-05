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
import { subnetIp, workerCookie } from "./lib/identity";
import { createPlaybackSession } from "./lib/playback";
import type { ManagedServer } from "./lib/server";
import { createServerFixture } from "./lib/server-fixture";

/**
 * Playback-session CONTROL-PLANE suite (no media segments — ffmpeg data-plane
 * throughput lives in streaming.bench). Covers the per-request surface a
 * running player actually drives: heartbeat (memory-only vs with progress
 * upsert), transcode-progress/diagnostics polling, create+release churn,
 * idempotent-replay and api-key-vs-cookie authentication.
 *
 * The fixture raises stream.maxSessions/maxSessionsPerUser to 100 (same PATCH
 * streaming.bench uses); SessionCreationGuard's 500ms cooldown is PER PROFILE,
 * so worker identities create in parallel without pacing, and churn/replay
 * phases count 429/409 as expected outcomes (status < 500).
 */

const MAX_SESSIONS = 100;

interface SessionsContext {
	baseUrl: string;
	cookieFor: (workerIndex: number, requestIndex: number) => string;
	profileIdFor: (workerIndex: number, requestIndex: number) => string;
	adminCookie: string;
	adminProfileId: string;
	sampleMediaId: string;
	/** Session + idempotency key created per worker identity during setup. */
	sessionIdFor: (workerIndex: number) => string;
	idempotencyKeyFor: (workerIndex: number) => string;
	/** Raw api key (created once) for the auth-comparison phase. */
	apiKey: string;
}

type SessionRequestBuilder = (context: SessionsContext, workerIndex: number, requestIndex: number) => Request;

function headers(context: SessionsContext, workerIndex: number, requestIndex: number): Record<string, string> {
	return {
		cookie: context.cookieFor(workerIndex, requestIndex),
		"x-profile-id": context.profileIdFor(workerIndex, requestIndex),
		"x-forwarded-for": subnetIp(88, workerIndex),
	};
}

function sessionPath(context: SessionsContext, workerIndex: number, suffix: string): string {
	return `${context.baseUrl}/v1/playback-sessions/${context.sessionIdFor(workerIndex)}${suffix}`;
}

const heartbeatEmpty: SessionRequestBuilder = (context, worker, request) =>
	new Request(sessionPath(context, worker, "/heartbeat"), { method: "POST", headers: headers(context, worker, request) });

const heartbeatProgress: SessionRequestBuilder = (context, worker, request) =>
	new Request(sessionPath(context, worker, "/heartbeat"), {
		method: "POST",
		headers: { ...headers(context, worker, request), "content-type": "application/json" },
		body: JSON.stringify({ position: request % 600, duration: 600, isPaused: false }),
	});

const transcodeProgress: SessionRequestBuilder = (context, worker, request) =>
	new Request(sessionPath(context, worker, "/transcode-progress"), { headers: headers(context, worker, request) });

const diagnostics: SessionRequestBuilder = (context, worker, request) =>
	new Request(sessionPath(context, worker, "/diagnostics"), { headers: headers(context, worker, request) });

const createChurn: SessionRequestBuilder = (context, worker, request) =>
	new Request(`${context.baseUrl}/v1/playback-sessions`, {
		method: "POST",
		headers: {
			...headers(context, worker, request),
			"content-type": "application/json",
			"idempotency-key": `bench-churn-${worker}-${request}`,
		},
		body: JSON.stringify({ mediaFileId: context.sampleMediaId, videoCodecs: ["h264"], audioCodecs: ["aac"] }),
	});

const idempotentReplay: SessionRequestBuilder = (context, worker, request) =>
	new Request(`${context.baseUrl}/v1/playback-sessions`, {
		method: "POST",
		headers: {
			...headers(context, worker, request),
			"content-type": "application/json",
			"idempotency-key": context.idempotencyKeyFor(worker),
		},
		body: JSON.stringify({ mediaFileId: context.sampleMediaId, videoCodecs: ["h264"], audioCodecs: ["aac"] }),
	});

const SCENARIOS: ReadonlyArray<readonly [string, SessionRequestBuilder]> = [
	["POST /:id/heartbeat (empty, in-memory)", heartbeatEmpty],
	["POST /:id/heartbeat (with progress upsert)", heartbeatProgress],
	["GET /:id/transcode-progress", transcodeProgress],
	["GET /:id/diagnostics", diagnostics],
	["POST / (create path + release; 409/429 = guard)", createChurn],
	["POST / (idempotent replay)", idempotentReplay],
];

function runScenario(
	scenario: readonly [string, SessionRequestBuilder],
	concurrency: number,
	context: SessionsContext,
	warmupMs: number,
	durationMs: number,
): Promise<HttpScenarioRun> {
	return runHttpScenario({
		concurrency,
		warmupMs,
		durationMs,
		work: async (workerIndex, requestIndex) => {
			try {
				const response = await fetch(scenario[1](context, workerIndex, requestIndex));
				if (!scenario[0].includes("churn")) {
					const ok = response.status < 500;
					await response.arrayBuffer();

					return { ok };
				}

				// Churn: create then release. 409 (session limit) and 429 (creation
				// cooldown) are the guards working as designed — a rejected create
				// IS a full decision-path sample. Only real failures count as errors.
				if (response.status === 409 || response.status === 429) {
					await response.arrayBuffer();

					return { ok: true };
				}
				if (response.status >= 500) return { ok: false };
				const created: unknown = await response.json();
				const sessionId = isRecord(created) && typeof created.sessionId === "string" ? created.sessionId : undefined;
				if (!sessionId) return { ok: false };

				const del = await fetch(`${context.baseUrl}/v1/playback-sessions/${sessionId}`, {
					method: "DELETE",
					headers: headers(context, workerIndex, requestIndex),
				});
				await del.arrayBuffer();

				return { ok: del.status < 500 };
			} catch {
				return { ok: false };
			}
		},
	});
}

async function raiseSessionLimits(server: ManagedServer): Promise<void> {
	const response = await fetch(`${server.baseUrl}/v1/admin/settings`, {
		method: "PATCH",
		headers: { cookie: server.cookie, "content-type": "application/json" },
		body: JSON.stringify({ "stream.maxSessions": MAX_SESSIONS, "stream.maxSessionsPerUser": MAX_SESSIONS }),
	});
	await response.arrayBuffer();
	if (!response.ok) throw new Error(`session-limit PATCH failed: HTTP ${response.status}`);
}

async function createSetupSession(server: ManagedServer, workerIndex: number): Promise<{ sessionId: string; idempotencyKey: string }> {
	const idempotencyKey = `bench-sessions-setup-${workerIndex}`;
	const isAdmin = workerIndex < 0;
	const sessionId = await createPlaybackSession(server, {
		cookie: isAdmin ? server.cookie : (server.workerCookies[workerIndex] ?? server.cookie),
		"x-profile-id": isAdmin ? server.adminProfileId : server.profileIdFor(workerIndex),
		"idempotency-key": idempotencyKey,
		"x-forwarded-for": subnetIp(88, Math.max(workerIndex, 0)),
	});

	return { sessionId, idempotencyKey };
}

/** Creates one api key (full scope) owned by the admin. */
async function createApiKey(server: ManagedServer): Promise<string> {
	const response = await fetch(`${server.baseUrl}/v1/admin/api-keys`, {
		method: "POST",
		headers: { cookie: server.cookie, "content-type": "application/json" },
		body: JSON.stringify({ name: "benchmark", scope: "full" }),
	});
	const body: unknown = await response.json();
	if (!(response.ok && isRecord(body)) || typeof body.key !== "string") {
		throw new Error(`api-key create failed: HTTP ${response.status}`);
	}

	return body.key;
}

/**
 * Auth comparison: heartbeat-with-progress against the ADMIN's own session,
 * once via session cookie, once via x-api-key (api keys resolve the owner's
 * role through a 5s cache; the cookie path runs better-auth derive).
 */
async function authComparisonPhase(
	context: SessionsContext,
	adminSessionId: string,
	concurrency: number,
	warmupMs: number,
	durationMs: number,
): Promise<void> {
	const rows: string[][] = [];
	const variants: ReadonlyArray<readonly [string, Record<string, string>]> = [
		["cookie", { cookie: context.adminCookie }],
		["x-api-key", { "x-api-key": context.apiKey }],
	];

	for (const [name, auth] of variants) {
		const run = await runHttpScenario({
			concurrency,
			warmupMs,
			durationMs,
			work: async () => {
				try {
					const response = await fetch(`${context.baseUrl}/v1/playback-sessions/${adminSessionId}/heartbeat`, {
						method: "POST",
						headers: {
							...auth,
							"x-profile-id": context.adminProfileId,
							"content-type": "application/json",
							"x-forwarded-for": "10.88.255.1",
						},
						body: JSON.stringify({ position: 42, duration: 600, isPaused: false }),
					});
					const ok = response.status < 500;
					await response.arrayBuffer();

					return { ok };
				} catch {
					return { ok: false };
				}
			},
		});
		const stats = summarizeLatencies(run.latencies.length > 0 ? run.latencies : [0]);
		rows.push([name, `${(run.successes / (durationMs / 1000)).toFixed(0)} ops/s`, fmtMs(stats.p50Ms), fmtMs(stats.p95Ms)]);
	}

	printTable("Auth comparison: heartbeat with progress (admin session)", ["auth", "throughput", "p50", "p95"], rows);
}

export const meta = { description: "Playback-session control plane (heartbeat, progress, polling, churn, replay, api-key auth)" };

const args = suiteArgs();

if (!args.help) {
	const serverFixture = createServerFixture({
		seedRows: args.rows,
		workerCount: Math.max(...args.concurrency, 12),
		withSampleMedia: true,
		keepServer: args.keepServer,
	});

	task("sessions-control: phases", async () => {
		const server = await serverFixture();
		if (!server.sampleMediaId) {
			console.error("Sample media unavailable — cannot run the sessions-control benchmark");
			process.exitCode = 1;

			return;
		}

		const results: HttpScenarioResult[] = [];
		await raiseSessionLimits(server);

		// One live session per worker identity (distinct profiles — the 500ms
		// creation cooldown is per profile, so no pacing needed here). ffmpeg
		// spawns per session; the 30s 640x360 ultrafast clip keeps that cheap.
		const workerCount = Math.min(Math.max(...args.concurrency, 12), server.workerCookies.length);
		const setup = await Promise.all(Array.from({ length: workerCount }, (_, workerIndex) => createSetupSession(server, workerIndex)));
		console.log(`[sessions] ${setup.length} live sessions (max ${MAX_SESSIONS}), api key created`);

		const adminSession = await createSetupSession(server, -1).catch(() => null);
		const apiKey = await createApiKey(server);

		const context: SessionsContext = {
			baseUrl: server.baseUrl,
			cookieFor: (workerIndex, requestIndex) => workerCookie(server, workerIndex * 997 + requestIndex),
			profileIdFor: (workerIndex, requestIndex) =>
				server.profileIdFor((workerIndex * 997 + requestIndex) % Math.max(server.workerCookies.length, 1)),
			adminCookie: server.cookie,
			adminProfileId: server.adminProfileId,
			sampleMediaId: server.sampleMediaId,
			sessionIdFor: (workerIndex) => setup[workerIndex % setup.length]?.sessionId ?? "",
			idempotencyKeyFor: (workerIndex) => setup[workerIndex % setup.length]?.idempotencyKey ?? "",
			apiKey,
		};

		for (const concurrency of args.concurrency) {
			console.log(`\n[sessions] concurrency ${concurrency} (warmup ${args.warmupMs}ms, measure ${args.durationMs}ms)`);
			for (const scenario of SCENARIOS) {
				const run = await runScenario(scenario, concurrency, context, args.warmupMs, args.durationMs);
				const result = httpScenarioResult(scenario[0], concurrency, run, args.durationMs);
				results.push(result);
				const failureNote = result.errorRatePercent > 0 ? `, errors ${result.errorRatePercent.toFixed(1)}%` : "";
				console.log(`  ${scenario[0]}: ${result.requestsPerSecond.toFixed(0)} ops/s, p95 ${result.stats.p95Ms.toFixed(1)}ms${failureNote}`);
			}
		}

		printHttpResults(results);

		if (adminSession) {
			await authComparisonPhase(
				{ ...context, sessionIdFor: () => adminSession.sessionId },
				adminSession.sessionId,
				Math.min(...args.concurrency),
				args.warmupMs,
				args.durationMs,
			);
		}

		// Teardown: release the setup sessions (async server-side).
		await Promise.all(
			setup.map((entry) =>
				fetch(`${server.baseUrl}/v1/playback-sessions/${entry.sessionId}`, {
					method: "DELETE",
					headers: { cookie: server.cookie },
				}).then((response) => response.arrayBuffer()),
			),
		);
	});
}

await main(import.meta);
