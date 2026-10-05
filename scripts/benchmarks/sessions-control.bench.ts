import {
	fmtMs,
	main,
	printHttpResults,
	printTable,
	runRequestScenario,
	runScenarioMatrix,
	type ScenarioMatrixEntry,
	suiteArgs,
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

/** 409/429 are the session guards working as designed — any non-5xx is a full decision-path sample. */
const acceptSessionResponse = (response: Response): boolean => response.status < 500;

/**
 * Churn: create then release. A rejected create (409 session limit / 429
 * cooldown) still measures the full decision path; only real failures count.
 */
async function churnWork(context: SessionsContext, workerIndex: number, requestIndex: number): Promise<{ ok: boolean }> {
	try {
		const response = await fetch(createChurn(context, workerIndex, requestIndex));
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
		const result = await runRequestScenario({
			name,
			concurrency,
			warmupMs,
			durationMs,
			requestFor: () =>
				new Request(`${context.baseUrl}/v1/playback-sessions/${adminSessionId}/heartbeat`, {
					method: "POST",
					headers: {
						...auth,
						"x-profile-id": context.adminProfileId,
						"content-type": "application/json",
						"x-forwarded-for": "10.88.255.1",
					},
					body: JSON.stringify({ position: 42, duration: 600, isPaused: false }),
				}),
		});
		rows.push([name, `${result.requestsPerSecond.toFixed(0)} ops/s`, fmtMs(result.stats.p50Ms), fmtMs(result.stats.p95Ms)]);
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

		const scenarioEntries: ScenarioMatrixEntry[] = [
			{
				name: "POST /:id/heartbeat (empty, in-memory)",
				requestFor: (workerIndex, requestIndex) => heartbeatEmpty(context, workerIndex, requestIndex),
				accept: acceptSessionResponse,
			},
			{
				name: "POST /:id/heartbeat (with progress upsert)",
				requestFor: (workerIndex, requestIndex) => heartbeatProgress(context, workerIndex, requestIndex),
				accept: acceptSessionResponse,
			},
			{
				name: "GET /:id/transcode-progress",
				requestFor: (workerIndex, requestIndex) => transcodeProgress(context, workerIndex, requestIndex),
				accept: acceptSessionResponse,
			},
			{
				name: "GET /:id/diagnostics",
				requestFor: (workerIndex, requestIndex) => diagnostics(context, workerIndex, requestIndex),
				accept: acceptSessionResponse,
			},
			{
				name: "POST / (create path + release; 409/429 = guard)",
				work: (workerIndex, requestIndex) => churnWork(context, workerIndex, requestIndex),
			},
			{
				name: "POST / (idempotent replay)",
				requestFor: (workerIndex, requestIndex) => idempotentReplay(context, workerIndex, requestIndex),
				accept: acceptSessionResponse,
			},
		];
		const results = await runScenarioMatrix({
			suite: "sessions",
			unit: "ops/s",
			scenarios: scenarioEntries,
			concurrency: args.concurrency,
			warmupMs: args.warmupMs,
			durationMs: args.durationMs,
		});

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
